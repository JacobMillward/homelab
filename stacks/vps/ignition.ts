import * as pulumi from "@pulumi/pulumi";
import { VPS_TUNNEL_ADDRESS, HOME_TUNNEL_IP, dockerImage } from "homelab-lib";
import { buildHaproxyConfig } from "./haproxy";
import { buildVpsCollectorConfig } from "./collector-config";
import { buildWgHandshakeScript } from "./wg-handshake";

export const HAPROXY_METRICS_BIND = "127.0.0.1:8404";

export interface IgnitionArgs {
  vpsPrivateKey: pulumi.Output<string>;
  homePubKey: pulumi.Output<string>;
  relayAuthSecret: pulumi.Output<string>;
  domain: string;
  relayPort: number;
  cloudflareApiToken: pulumi.Output<string>;
  otlpApiKey: pulumi.Output<string>;
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
    otlpApiKey,
  } = args;

  return pulumi
    .all([vpsPrivateKey, homePubKey, relayAuthSecret, cloudflareApiToken, otlpApiKey])
    .apply(([vpsPriv, homePub, relayAuth, cfToken, otlpKey]) =>
      JSON.stringify({
        ignition: { version: "3.4.0" },
        storage: {
          directories: [
            { path: "/etc/wireguard", mode: 0o700 },
            { path: "/etc/relay-tls", mode: 0o700 },
            { path: "/var/lib/acme-state", mode: 0o700 },
            { path: "/var/lib/otelcol", mode: 0o755 },
            { path: "/var/lib/node-exporter-textfile", mode: 0o755 },
            { path: "/opt/bin", mode: 0o755 },
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
                source: dataUrl(buildHaproxyConfig({ homeTunnelIp: HOME_TUNNEL_IP, metricsBind: HAPROXY_METRICS_BIND })),
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
              path: "/etc/otel-collector.yaml",
              mode: 0o644,
              contents: {
                source: dataUrl(
                  buildVpsCollectorConfig({
                    gatewayEndpoint: `http://${HOME_TUNNEL_IP}:4318`,
                    apiKeyEnvVar: "HYPERDX_API_KEY",
                    relayTlsEndpoint: `127.0.0.1:${relayPort}`,
                    haproxyMetricsEndpoint: HAPROXY_METRICS_BIND,
                    nodeExporterEndpoint: "127.0.0.1:9100",
                  }),
                ),
              },
            },
            {
              path: "/etc/otel-collector.env",
              mode: 0o600,
              contents: { source: dataUrl(`HYPERDX_API_KEY=${otlpKey}\n`) },
            },
            {
              path: "/opt/bin/wg-handshake.sh",
              mode: 0o755,
              contents: { source: dataUrl(buildWgHandshakeScript({ textfileDir: "/var/lib/node-exporter-textfile" })) },
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
            // No keys are provisioned, so this only occupies Forgejo's SSH port.
            { name: "sshd.socket", mask: true },
            { name: "sshd.service", mask: true },
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
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \\
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
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \\
  --env-file /etc/relay.env \\
  -v /etc/relay-tls:/certs:ro \\
  netbirdio/relay:0.67.4
ExecStop=/usr/bin/docker stop relay

[Install]
WantedBy=multi-user.target
`,
            },
            {
              name: "otel-collector.service",
              enabled: true,
              contents: `[Unit]
Description=OpenTelemetry Collector (VPS telemetry to home ClickStack over WireGuard)
After=docker.service wg-quick@wg0.service
Requires=docker.service

[Service]
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker rm -f otel-collector
# journald, not json-file, so the collector never reads its own output back in.
ExecStart=/usr/bin/docker run --rm --name otel-collector \\
  --network host \\
  --user 0 \\
  --log-driver journald \\
  --env-file /etc/otel-collector.env \\
  -v /etc/otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro \\
  -v /var/lib/otelcol:/var/lib/otelcol \\
  -v /var/lib/docker/containers:/var/lib/docker/containers:ro \\
  -v /proc:/hostfs/proc:ro \\
  -v /sys:/hostfs/sys:ro \\
  ${dockerImage("otelCollectorContrib")}
ExecStop=/usr/bin/docker stop otel-collector

[Install]
WantedBy=multi-user.target
`,
            },
            {
              name: "node-exporter.service",
              enabled: true,
              contents: `[Unit]
Description=node_exporter (textfile metrics only, for the WireGuard handshake age)
After=docker.service
Requires=docker.service

[Service]
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker rm -f node-exporter
ExecStart=/usr/bin/docker run --rm --name node-exporter \\
  --network host \\
  --log-driver journald \\
  -v /var/lib/node-exporter-textfile:/textfile:ro \\
  ${dockerImage("nodeExporter")} \\
  --collector.disable-defaults \\
  --collector.textfile \\
  --collector.textfile.directory=/textfile \\
  --web.listen-address=127.0.0.1:9100
ExecStop=/usr/bin/docker stop node-exporter

[Install]
WantedBy=multi-user.target
`,
            },
            {
              name: "wg-handshake.service",
              contents: `[Unit]
Description=Write the WireGuard handshake age for node_exporter
After=wg-quick@wg0.service

[Service]
Type=oneshot
ExecStart=/opt/bin/wg-handshake.sh
`,
            },
            {
              name: "wg-handshake.timer",
              enabled: true,
              contents: `[Unit]
Description=Update the WireGuard handshake age every 30 seconds

[Timer]
OnBootSec=30s
OnUnitActiveSec=30s

[Install]
WantedBy=timers.target
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
