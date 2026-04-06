import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { PlatformCtx } from "../context";

export interface VpsTunnelArgs {
  namespace: k8s.core.v1.Namespace;
  vpsIp: pulumi.Input<string>;
  vpsWgPublicKey: pulumi.Input<string>;
  homeWgPrivateKey: pulumi.Input<string>;
}

export class VpsTunnel extends pulumi.ComponentResource {
  constructor(ctx: PlatformCtx, args: VpsTunnelArgs) {
    super("platform:netbird:VpsTunnel", "vps-tunnel", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const { namespace, vpsIp, vpsWgPublicKey, homeWgPrivateKey } = args;

    const wgConfig = new k8s.core.v1.Secret(
      "wg-home-config",
      {
        metadata: {
          name: "wg-home-config",
          namespace: namespace.metadata.name,
        },
        stringData: {
          "wg0.conf": pulumi.interpolate`[Interface]
Address = 10.99.0.2/24
PrivateKey = ${homeWgPrivateKey}

[Peer]
PublicKey = ${vpsWgPublicKey}
Endpoint = ${vpsIp}:51820
AllowedIPs = 10.99.0.1/32
PersistentKeepalive = 25
`,
        },
      },
      { parent: this },
    );

    const server = "netbird-server.netbird.svc.cluster.local";
    const dashboard = "netbird-dashboard.netbird.svc.cluster.local";

    const nginxConfig = new k8s.core.v1.ConfigMap(
      "wg-nginx-config",
      {
        metadata: {
          name: "wg-nginx-config",
          namespace: namespace.metadata.name,
        },
        data: {
          "default.conf": `server {
    listen 80;
    http2 on;
    # gRPC (h2c) - long-lived streams need extended timeouts
    grpc_read_timeout 24h;
    grpc_send_timeout 24h;
    location /signalexchange.SignalExchange/ {
        grpc_pass grpc://${server}:80;
    }
    location /management.ManagementService/ {
        grpc_pass grpc://${server}:80;
    }
    # API, OAuth, WebSocket
    location /api { proxy_pass http://${server}; }
    location /oauth2 { proxy_pass http://${server}; }
    location /ws-proxy/ {
        proxy_pass http://${server};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
    # Dashboard catch-all
    location / { proxy_pass http://${dashboard}; }
}
`,
        },
      },
      { parent: this },
    );

    // WireGuard tunnel to VPS with nginx for path-based routing to the
    // correct backend (server vs dashboard).
    new k8s.apps.v1.Deployment(
      "wg-home-peer",
      {
        metadata: {
          name: "wg-home-peer",
          namespace: namespace.metadata.name,
        },
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
                    "apk add --no-cache wireguard-tools iproute2 && " +
                      "install -m 0600 /secret/wg0.conf /etc/wireguard/wg0.conf && " +
                      "wg-quick up wg0 && " +
                      "trap 'wg-quick down wg0; exit 0' TERM INT && " +
                      "while :; do sleep 86400 & wait $!; done",
                  ],
                  securityContext: {
                    capabilities: { add: ["NET_ADMIN"] },
                  },
                  volumeMounts: [{ name: "wg-config", mountPath: "/secret", readOnly: true }],
                },
                {
                  name: "proxy",
                  image: "nginx:1.27-alpine",
                  ports: [{ containerPort: 80 }],
                  volumeMounts: [
                    {
                      name: "nginx-config",
                      mountPath: "/etc/nginx/conf.d",
                      readOnly: true,
                    },
                  ],
                },
              ],
              volumes: [
                {
                  name: "wg-config",
                  secret: { secretName: wgConfig.metadata.name },
                },
                {
                  name: "nginx-config",
                  configMap: { name: nginxConfig.metadata.name },
                },
              ],
            },
          },
        },
      },
      { parent: this },
    );
  }
}
