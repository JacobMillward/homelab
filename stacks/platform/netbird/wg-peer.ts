import * as crypto from "crypto";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { HOME_TUNNEL_ADDRESS, VPS_TUNNEL_IP, dockerImage } from "homelab-lib";
import { PlatformCtx } from "../context";
import { buildForwardRules } from "./forward-rules";

export interface VpsTunnelArgs {
  namespace: k8s.core.v1.Namespace;
  vpsIp: pulumi.Input<string>;
  vpsWgPublicKey: pulumi.Input<string>;
  traefikIp: pulumi.Input<string>;
  forgejoSshIp: pulumi.Input<string>;
  // Cluster DNS name of the telemetry gateway. The VPS pushes OTLP/HTTP (4318) to it over the tunnel.
  otlpGatewayHost: pulumi.Input<string>;
}

export class VpsTunnel extends pulumi.ComponentResource {
  constructor(ctx: PlatformCtx, args: VpsTunnelArgs) {
    super("platform:netbird:VpsTunnel", "vps-tunnel", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const { namespace, vpsIp, vpsWgPublicKey, traefikIp, forgejoSshIp, otlpGatewayHost } = args;

    const core = pulumi
      .all([traefikIp, forgejoSshIp])
      .apply(([https, ssh]) => buildForwardRules([{ port: 443, dest: https }, { port: 22, dest: ssh }]));
    // The gateway has no fixed IP, so wg-quick resolves its Service name when the tunnel comes up.
    // Separate and non-fatal: a DNS hiccup must not take the public tunnel down with it.
    const otlp = pulumi.output(otlpGatewayHost).apply((gateway) =>
      buildForwardRules([{ port: 4318, dest: `$(getent hosts ${gateway} | awk '{print $1; exit}')` }]),
    );
    // Rules only run at tunnel start, so a rule change has to roll the pod.
    const rulesHash = pulumi
      .all([core, otlp])
      .apply(([c, o]) => crypto.createHash("sha256").update(c.up + o.up).digest("hex"));

    const privateKeyPlaceholder = "__HOME_WG_PRIVATE_KEY__";

    const wgConfigTemplate = new k8s.core.v1.ConfigMap(
      "wg-home-config-template",
      {
        metadata: { name: "wg-home-config-template", namespace: namespace.metadata.name },
        data: {
          "wg0.conf": pulumi.interpolate`[Interface]
Address = ${HOME_TUNNEL_ADDRESS}
PrivateKey = ${privateKeyPlaceholder}
PostUp = sysctl -w net.ipv4.ip_forward=1; ${core.up}
PostUp = ${otlp.up} || true
PostDown = ${core.down}
PostDown = ${otlp.down} || true

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
            metadata: { labels: { app: "wg-home-peer" }, annotations: { "homelab.internal/wg-rules-hash": rulesHash } },
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
