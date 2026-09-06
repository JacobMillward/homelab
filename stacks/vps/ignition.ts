import * as pulumi from "@pulumi/pulumi";

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
  const { vpsPrivateKey, homePubKey, relayAuthSecret, domain, relayPort, cloudflareApiToken } =
    args;

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
Address = 10.99.0.1/24
ListenPort = 51820
PrivateKey = ${vpsPriv}
PostUp = iptables -t nat -A PREROUTING -p tcp --dport 443 -j DNAT --to-destination 10.99.0.2:443; iptables -A FORWARD -p tcp -d 10.99.0.2 --dport 443 -j ACCEPT
PostDown = iptables -t nat -D PREROUTING -p tcp --dport 443 -j DNAT --to-destination 10.99.0.2:443; iptables -D FORWARD -p tcp -d 10.99.0.2 --dport 443 -j ACCEPT

[Peer]
PublicKey = ${homePub}
AllowedIPs = 10.99.0.2/32
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
