import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { HOME_TUNNEL_ADDRESS, VPS_TUNNEL_IP, dockerImage } from "homelab-lib";
import { PlatformCtx } from "../context";

export interface VpsTunnelArgs {
  namespace: k8s.core.v1.Namespace;
  vpsIp: pulumi.Input<string>;
  vpsWgPublicKey: pulumi.Input<string>;
  traefikIp: pulumi.Input<string>;
  forgejoSshIp: pulumi.Input<string>;
}

export class VpsTunnel extends pulumi.ComponentResource {
  constructor(ctx: PlatformCtx, args: VpsTunnelArgs) {
    super("platform:netbird:VpsTunnel", "vps-tunnel", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const { namespace, vpsIp, vpsWgPublicKey, traefikIp, forgejoSshIp } = args;

    const forward = (port: number, dest: pulumi.Input<string>) =>
      pulumi.interpolate`iptables -t nat -%OP% PREROUTING -p tcp --dport ${port} -j DNAT --to-destination ${dest}:${port}; iptables -%OP% FORWARD -p tcp -d ${dest} --dport ${port} -j ACCEPT; iptables -t nat -%OP% POSTROUTING -p tcp -d ${dest} --dport ${port} -j MASQUERADE`;

    const rules = pulumi
      .all([forward(443, traefikIp), forward(22, forgejoSshIp)])
      .apply(([https, ssh]) => ({
        up: [https, ssh].join("; ").replace(/%OP%/g, "A"),
        down: [https, ssh].join("; ").replace(/%OP%/g, "D"),
      }));

    const privateKeyPlaceholder = "__HOME_WG_PRIVATE_KEY__";

    const wgConfigTemplate = new k8s.core.v1.ConfigMap(
      "wg-home-config-template",
      {
        metadata: { name: "wg-home-config-template", namespace: namespace.metadata.name },
        data: {
          "wg0.conf": pulumi.interpolate`[Interface]
Address = ${HOME_TUNNEL_ADDRESS}
PrivateKey = ${privateKeyPlaceholder}
PostUp = sysctl -w net.ipv4.ip_forward=1; ${rules.up}
PostDown = ${rules.down}

[Peer]
PublicKey = ${vpsWgPublicKey}
Endpoint = ${vpsIp}:51820
AllowedIPs = ${VPS_TUNNEL_IP}/32
PersistentKeepalive = 25
`,
        },
      },
      { parent: this },
    );

    new k8s.apps.v1.Deployment(
      "wg-home-peer",
      {
        metadata: { name: "wg-home-peer", namespace: namespace.metadata.name },
        spec: {
          replicas: 1,
          // Recreate: two pods sharing this peer identity would fight over one WireGuard session.
          strategy: { type: "Recreate" },
          progressDeadlineSeconds: 120,
          selector: { matchLabels: { app: "wg-home-peer" } },
          template: {
            metadata: { labels: { app: "wg-home-peer" } },
            spec: {
              containers: [
                {
                  name: "wireguard",
                  image: dockerImage("netbirdWgPeer"),
                  command: [
                    "sh",
                    "-c",
                    "apk add --no-cache wireguard-tools iproute2 iptables && " +
                      `sed "s|${privateKeyPlaceholder}|$(cat /secrets/home-wg-private-key)|" /etc/wireguard-template/wg0.conf > /etc/wireguard/wg0.conf && ` +
                      "chmod 0600 /etc/wireguard/wg0.conf && " +
                      "wg-quick up wg0 && " +
                      "trap 'wg-quick down wg0; exit 0' TERM INT && " +
                      "while :; do sleep 86400 & wait $!; done",
                  ],
                  securityContext: { privileged: true },
                  readinessProbe: {
                    exec: { command: ["sh", "-c", "wg show wg0 latest-handshakes | awk '{exit ($2==0)}'"] },
                    initialDelaySeconds: 15,
                    periodSeconds: 15,
                    failureThreshold: 3,
                  },
                  volumeMounts: [
                    { name: "wg-config-template", mountPath: "/etc/wireguard-template", readOnly: true },
                    { name: "wg-config-rendered", mountPath: "/etc/wireguard" },
                    { name: "home-wg-key", mountPath: "/secrets", readOnly: true },
                  ],
                },
              ],
              volumes: [
                { name: "wg-config-template", configMap: { name: wgConfigTemplate.metadata.name } },
                { name: "wg-config-rendered", emptyDir: {} },
                { name: "home-wg-key", secret: { secretName: "vps-secrets" } },
              ],
            },
          },
        },
      },
      { parent: this },
    );
  }
}
