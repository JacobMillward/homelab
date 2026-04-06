import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
import * as command from "@pulumi/command";
import * as hcloud from "@pulumi/hcloud";
import * as onepassword from "@1password/pulumi-onepassword";
import * as random from "@pulumi/random";
import { getSnapshotId } from "./flatcar";

const config = new pulumi.Config();
const domain = "netbird.millward-yuan.net";
const relayPort = 33443;

// ---------------------------------------------------------------------------
// 1Password secrets
// ---------------------------------------------------------------------------

const opItem = onepassword.getItemOutput({
  vault: "Private",
  title: "Homelab",
});

function opField(label: string): pulumi.Output<string> {
  return opItem.apply((item) => {
    const field = (item.sections ?? [])
      .flatMap((s) => s.fields ?? [])
      .find((f) => f.label === label);
    if (!field) throw new Error(`1Password field "${label}" not found`);
    return field.value;
  });
}

const hcloudToken = opField("Hetzner API Token");
const cloudflareApiToken = opField("Cloudflare Api Token (DnsEdit)");

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

const relaySecret = new random.RandomPassword("relay-auth-secret", {
  length: 32,
  special: false,
});

// ---------------------------------------------------------------------------
// WireGuard keypairs
// ---------------------------------------------------------------------------

// wg genkey applies Curve25519 clamping; wg pubkey derives the public half.
// Output: "privateKey|publicKey". Runs once and is stored in Pulumi state.
const wgKeygenScript = `priv=$(wg genkey); pub=$(echo "$priv" | wg pubkey); echo -n "$priv|$pub"`;

const vpsKeys = new command.local.Command(
  "wg-vps-keypair",
  { create: wgKeygenScript, logging: "none" },
  { additionalSecretOutputs: ["stdout"] },
);
const homeKeys = new command.local.Command(
  "wg-home-keypair",
  { create: wgKeygenScript, logging: "none" },
  { additionalSecretOutputs: ["stdout"] },
);

// ---------------------------------------------------------------------------
// Ignition config (Flatcar first-boot provisioning)
// ---------------------------------------------------------------------------

// Ignition mode fields are decimal representations of octal permissions
// (e.g. 0o755 = 493, 0o600 = 384). Ignition interprets them correctly.
const ignitionConfig = pulumi
  .all([vpsKeys.stdout, homeKeys.stdout, relaySecret.result])
  .apply(([vpsKp, homeKp, relayAuth]) => {
    const vpsPriv = vpsKp.split("|")[0];
    const homePub = homeKp.split("|")[1];

    return JSON.stringify({
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
ExecStart=/usr/bin/docker run --rm --name caddy \
  --network host \
  -v /var/lib/caddy:/data \
  -v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
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
ExecStart=/usr/bin/docker run --rm --name relay \
  --network host \
  --env-file /etc/relay.env \
  netbirdio/relay:0.66.4
ExecStop=/usr/bin/docker stop relay

[Install]
WantedBy=multi-user.target
`,
          },
        ],
      },
    });
  });

// ---------------------------------------------------------------------------
// Hetzner server
// ---------------------------------------------------------------------------

const hcloudProvider = new hcloud.Provider("hcloud", {
  token: hcloudToken,
});
const providerOpts = { provider: hcloudProvider };

const firewall = new hcloud.Firewall(
  "netbird-vps-fw",
  {
    rules: [
      {
        direction: "in",
        protocol: "tcp",
        port: "80",
        sourceIps: ["0.0.0.0/0", "::/0"],
        description: "ACME HTTP-01",
      },
      {
        direction: "in",
        protocol: "tcp",
        port: "443",
        sourceIps: ["0.0.0.0/0", "::/0"],
        description: "Caddy HTTPS (management + dashboard)",
      },
      {
        direction: "in",
        protocol: "tcp",
        port: String(relayPort),
        sourceIps: ["0.0.0.0/0", "::/0"],
        description: "NetBird relay (TLS via Caddy)",
      },
      {
        direction: "in",
        protocol: "udp",
        port: "3478",
        sourceIps: ["0.0.0.0/0", "::/0"],
        description: "STUN",
      },
      {
        direction: "in",
        protocol: "udp",
        port: "51820",
        sourceIps: ["0.0.0.0/0", "::/0"],
        description: "WireGuard",
      },
    ],
  },
  providerOpts,
);

const server = new hcloud.Server(
  "netbird-vps",
  {
    serverType: config.require("serverType"),
    image: getSnapshotId(hcloudToken),
    location: config.require("serverLocation"),
    userData: ignitionConfig,
    firewallIds: [firewall.id.apply((id) => Number(id))],
  },
  { ...providerOpts, replaceOnChanges: ["userData"] },
);

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

const cloudflareProvider = new cloudflare.Provider("cloudflare", {
  apiToken: cloudflareApiToken,
});

const cloudflareZone = cloudflare.getZoneOutput(
  { filter: { name: "millward-yuan.net" } },
  { provider: cloudflareProvider },
);

new cloudflare.DnsRecord(
  "netbird-dns",
  {
    zoneId: cloudflareZone.id,
    name: "netbird",
    type: "A",
    content: server.ipv4Address,
    proxied: false,
    ttl: 60,
  },
  { provider: cloudflareProvider },
);

// ---------------------------------------------------------------------------
// Exports (clean names - these are the public API for StackReference)
// ---------------------------------------------------------------------------

export const vpsIp = server.ipv4Address;
export const vpsWgPublicKey = vpsKeys.stdout.apply((s) => s.split("|")[1]);
export const homeWgPrivateKey = pulumi.secret(
  homeKeys.stdout.apply((s) => s.split("|")[0]),
);
export const homeWgPublicKey = homeKeys.stdout.apply((s) => s.split("|")[1]);
export const relayAuthSecret = pulumi.secret(relaySecret.result);
export const relayAddress = pulumi.interpolate`rels://${domain}:${relayPort}`;
export const stunAddress = pulumi.interpolate`stun:${domain}:3478`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Encode a string as a data URL for Ignition file contents
function dataUrl(content: string): string {
  return `data:,${encodeURIComponent(content)}`;
}
