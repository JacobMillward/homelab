import * as pulumi from "@pulumi/pulumi";

export interface IgnitionArgs {
  vpsPrivateKey: pulumi.Output<string>;
  homePubKey: pulumi.Output<string>;
  relayAuthSecret: pulumi.Output<string>;
  domain: string;
  relayPort: number;
}

// Encode a string as a data URL for Ignition file contents.
function dataUrl(content: string): string {
  return `data:,${encodeURIComponent(content)}`;
}

// Pure function — no Pulumi resources, just config generation.
// Ignition mode fields are decimal representations of octal permissions
// (e.g. 0o755 = 493, 0o600 = 384). Ignition interprets them correctly.
export function buildIgnitionConfig(args: IgnitionArgs): pulumi.Output<string> {
  const { vpsPrivateKey, homePubKey, relayAuthSecret, domain, relayPort } =
    args;

  return pulumi
    .all([vpsPrivateKey, homePubKey, relayAuthSecret])
    .apply(([vpsPriv, homePub, relayAuth]) =>
      JSON.stringify({
        ignition: { version: "3.4.0" },
        storage: {
          directories: [
            { path: "/var/lib/caddy", mode: 0o755 },
            { path: "/etc/wireguard", mode: 0o700 },
          ],
          files: [
            {
              path: "/etc/wireguard/wg0.conf",
              mode: 0o600,
              contents: {
                source: dataUrl(`[Interface]
Address = 10.99.0.1/24
ListenPort = 51820
PrivateKey = ${vpsPriv}

[Peer]
PublicKey = ${homePub}
AllowedIPs = 10.99.0.2/32
`),
              },
            },
            {
              path: "/etc/caddy/Caddyfile",
              mode: 0o644,
              contents: {
                source: dataUrl(`${domain} {
    # gRPC: signal + management (h2c to backend)
    handle /signalexchange.SignalExchange/* {
        reverse_proxy 10.99.0.2:80 {
            transport http {
                versions h2c
            }
        }
    }
    handle /management.ManagementService/* {
        reverse_proxy 10.99.0.2:80 {
            transport http {
                versions h2c
            }
        }
    }

    # HTTP: API, OAuth, WebSocket proxy
    handle /api* {
        reverse_proxy 10.99.0.2:80
    }
    handle /oauth2* {
        reverse_proxy 10.99.0.2:80
    }
    handle /ws-proxy/* {
        reverse_proxy 10.99.0.2:80
    }

    # Dashboard catch-all
    handle {
        reverse_proxy 10.99.0.2:80
    }
}

# Relay on separate port (standalone relay serves at root path)
${domain}:${relayPort} {
    reverse_proxy localhost:33080
}
`),
              },
            },
            {
              path: "/etc/relay.env",
              mode: 0o600,
              contents: {
                // NB_EXPOSED_ADDRESS uses rel:// (no TLS) because Caddy
                // terminates TLS on port ${relayPort} before forwarding here.
                source: dataUrl(
                  `NB_LISTEN_ADDRESS=:33080
NB_EXPOSED_ADDRESS=rel://0.0.0.0:33080
NB_AUTH_SECRET=${relayAuth}
NB_ENABLE_STUN=true
NB_STUN_PORTS=3478
`,
                ),
              },
            },
          ],
        },
        systemd: {
          units: [
            {
              name: "wg-quick@wg0.service",
              enabled: true,
            },
            {
              name: "caddy.service",
              enabled: true,
              contents: `[Unit]
Description=Caddy reverse proxy
After=docker.service
Requires=docker.service

[Service]
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker rm -f caddy
ExecStart=/usr/bin/docker run --rm --name caddy \\
  --network host \\
  -v /var/lib/caddy:/data \\
  -v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \\
  caddy:2.9.1-alpine
ExecStop=/usr/bin/docker stop caddy

[Install]
WantedBy=multi-user.target
`,
            },
            {
              name: "relay.service",
              enabled: true,
              contents: `[Unit]
Description=NetBird relay
After=docker.service
Requires=docker.service

[Service]
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker rm -f relay
ExecStart=/usr/bin/docker run --rm --name relay \\
  --network host \\
  --env-file /etc/relay.env \\
  netbirdio/relay:0.66.4
ExecStop=/usr/bin/docker stop relay

[Install]
WantedBy=multi-user.target
`,
            },
          ],
        },
      }),
    );
}
