import * as pulumi from "@pulumi/pulumi";
import { VPS_TUNNEL_ADDRESS, HOME_TUNNEL_IP } from "homelab-lib";

export interface IgnitionArgs {
  vpsPrivateKey: pulumi.Output<string>;
  homePubKey: pulumi.Output<string>;
  relayAuthSecret: pulumi.Output<string>;
  domain: string;
  relayPort: number;
  cloudflareApiToken: pulumi.Output<string>;
}

// Encode a string as a data URL for Ignition file contents.
function dataUrl(content: string): string {
  return `data:,${encodeURIComponent(content)}`;
}

// Pure function — no Pulumi resources, just config generation.
// Ignition mode fields are decimal representations of octal permissions
// (e.g. 0o755 = 493, 0o600 = 384). Ignition interprets them correctly.
export function buildIgnitionConfig(args: IgnitionArgs): pulumi.Output<string> {
  const {
    vpsPrivateKey,
    homePubKey,
    relayAuthSecret,
    domain,
    relayPort,
    cloudflareApiToken,
  } = args;

  return pulumi
    .all([vpsPrivateKey, homePubKey, relayAuthSecret, cloudflareApiToken])
    .apply(([vpsPriv, homePub, relayAuth, cfToken]) =>
      JSON.stringify({
        ignition: { version: "3.4.0" },
        storage: {
          directories: [
            { path: "/etc/wireguard", mode: 0o700 },
            { path: "/etc/relay-tls", mode: 0o700 },
            { path: "/var/lib/acme-state", mode: 0o700 },
          ],
          files: [
            {
              path: "/etc/wireguard/wg0.conf",
              mode: 0o600,
              contents: {
                source: dataUrl(`[Interface]
Address = ${VPS_TUNNEL_ADDRESS}
ListenPort = 51820
PrivateKey = ${vpsPriv}

[Peer]
PublicKey = ${homePub}
AllowedIPs = ${HOME_TUNNEL_IP}/32
`),
              },
            },
            {
              path: "/etc/haproxy.cfg",
              mode: 0o644,
              contents: {
                source: dataUrl(`global
    maxconn 4096

defaults
    mode tcp
    timeout connect 5s
    timeout client 1h
    timeout server 1h

frontend app_publish
    bind *:443
    default_backend home_traefik

backend home_traefik
    server home ${HOME_TUNNEL_IP}:443 send-proxy
`),
              },
            },
            {
              path: "/etc/relay.env",
              mode: 0o600,
              contents: {
                source: dataUrl(
                  `NB_LISTEN_ADDRESS=:${relayPort}
NB_EXPOSED_ADDRESS=rels://${domain}:${relayPort}
NB_AUTH_SECRET=${relayAuth}
NB_ENABLE_STUN=true
NB_STUN_PORTS=3478
NB_TLS_CERT_FILE=/certs/fullchain.pem
NB_TLS_KEY_FILE=/certs/privkey.pem
`,
                ),
              },
            },
            {
              path: "/etc/acme-cf.env",
              mode: 0o600,
              contents: {
                source: dataUrl(`CF_Token=${cfToken}\n`),
              },
            },
          ],
        },
        systemd: {
          units: [
            { name: "wg-quick@wg0.service", enabled: true },
            {
              name: "haproxy.service",
              enabled: true,
              contents: `[Unit]
Description=HAProxy (app-publish tunnel, PROXY protocol to home Traefik)
After=docker.service wg-quick@wg0.service
Requires=docker.service

[Service]
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker rm -f haproxy
ExecStartPre=/usr/bin/sysctl -w net.ipv4.ip_unprivileged_port_start=0
ExecStart=/usr/bin/docker run --rm --name haproxy \\
  --network host \\
  -v /etc/haproxy.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro \\
  haproxy:3.4.4-alpine
ExecStop=/usr/bin/docker stop haproxy

[Install]
WantedBy=multi-user.target
`,
            },
            {
              name: "relay.service",
              enabled: true,
              contents: `[Unit]
Description=NetBird relay (native TLS)
After=docker.service
Requires=docker.service

[Service]
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker rm -f relay
ExecStart=/usr/bin/docker run --rm --name relay \\
  --network host \\
  --env-file /etc/relay.env \\
  -v /etc/relay-tls:/certs:ro \\
  netbirdio/relay:0.67.4
ExecStop=/usr/bin/docker stop relay

[Install]
WantedBy=multi-user.target
`,
            },
            {
              name: "acme-issue.service",
              contents: `[Unit]
Description=Issue/renew relay TLS certificate via acme.sh (Cloudflare DNS-01)
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStartPre=-/usr/bin/docker rm -f acme-issue
ExecStart=/usr/bin/docker run --rm --name acme-issue \\
  --network host \\
  -v /var/lib/acme-state:/acme.sh \\
  -v /etc/relay-tls:/relay-tls \\
  --env-file /etc/acme-cf.env \\
  neilpang/acme.sh --issue --dns dns_cf -d ${domain} --server letsencrypt
ExecStart=/usr/bin/docker run --rm --name acme-issue \\
  --network host \\
  -v /var/lib/acme-state:/acme.sh \\
  -v /etc/relay-tls:/relay-tls \\
  neilpang/acme.sh --install-cert -d ${domain} \\
  --fullchain-file /relay-tls/fullchain.pem \\
  --key-file /relay-tls/privkey.pem
ExecStartPost=-/usr/bin/docker restart relay
`,
            },
            {
              name: "acme-issue.timer",
              enabled: true,
              contents: `[Unit]
Description=Run acme-issue.service on boot and daily thereafter

[Timer]
OnBootSec=2min
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
`,
            },
          ],
        },
      }),
    );
}
