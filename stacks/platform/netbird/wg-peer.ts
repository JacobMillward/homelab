import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { HOME_TUNNEL_ADDRESS, VPS_TUNNEL_IP } from "homelab-lib";
import { PlatformCtx } from "../context";

export interface VpsTunnelArgs {
  namespace: k8s.core.v1.Namespace;
  vpsIp: pulumi.Input<string>;
  vpsWgPublicKey: pulumi.Input<string>;
  homeWgPrivateKey: pulumi.Input<string>;
  traefikIp: pulumi.Input<string>;
}

export class VpsTunnel extends pulumi.ComponentResource {
  constructor(ctx: PlatformCtx, args: VpsTunnelArgs) {
    super("platform:netbird:VpsTunnel", "vps-tunnel", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const { namespace, vpsIp, vpsWgPublicKey, homeWgPrivateKey, traefikIp } = args;

    const wgConfig = new k8s.core.v1.Secret(
      "wg-home-config",
      {
        metadata: { name: "wg-home-config", namespace: namespace.metadata.name },
        stringData: {
          "wg0.conf": pulumi.interpolate`[Interface]
Address = ${HOME_TUNNEL_ADDRESS}
PrivateKey = ${homeWgPrivateKey}
PostUp = sysctl -w net.ipv4.ip_forward=1; iptables -t nat -A PREROUTING -p tcp --dport 443 -j DNAT --to-destination ${traefikIp}:443; iptables -A FORWARD -p tcp -d ${traefikIp} --dport 443 -j ACCEPT; iptables -t nat -A POSTROUTING -p tcp -d ${traefikIp} --dport 443 -j MASQUERADE
PostDown = iptables -t nat -D PREROUTING -p tcp --dport 443 -j DNAT --to-destination ${traefikIp}:443; iptables -D FORWARD -p tcp -d ${traefikIp} --dport 443 -j ACCEPT; iptables -t nat -D POSTROUTING -p tcp -d ${traefikIp} --dport 443 -j MASQUERADE

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
          strategy: { type: "Recreate" },
          selector: { matchLabels: { app: "wg-home-peer" } },
          template: {
            metadata: { labels: { app: "wg-home-peer" } },
            spec: {
              containers: [
                {
                  name: "wireguard",
                  image: "alpine:3.21",
                  command: [
                    "sh",
                    "-c",
                    "apk add --no-cache wireguard-tools iproute2 iptables && " +
                      "install -m 0600 /secret/wg0.conf /etc/wireguard/wg0.conf && " +
                      "wg-quick up wg0 && " +
                      "trap 'wg-quick down wg0; exit 0' TERM INT && " +
                      "while :; do sleep 86400 & wait $!; done",
                  ],
                  securityContext: { privileged: true },
                  volumeMounts: [{ name: "wg-config", mountPath: "/secret", readOnly: true }],
                },
              ],
              volumes: [{ name: "wg-config", secret: { secretName: wgConfig.metadata.name } }],
            },
          },
        },
      },
      { parent: this },
    );
  }
}
