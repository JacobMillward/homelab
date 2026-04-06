import * as pulumi from "@pulumi/pulumi";
import * as cloudflare from "@pulumi/cloudflare";
import * as command from "@pulumi/command";
import * as hcloud from "@pulumi/hcloud";
import * as random from "@pulumi/random";
import { getSnapshotId } from "./flatcar";
import { buildIgnitionConfig } from "./ignition";
import { makeOpField } from "homelab-lib";

const relayPort = 33443;

// wg genkey applies Curve25519 clamping; wg pubkey derives the public half.
// Output: "privateKey|publicKey". Runs once and is stored in Pulumi state.
const wgKeygenScript = `priv=$(wg genkey); pub=$(echo "$priv" | wg pubkey); echo -n "$priv|$pub"`;

export class VpsServer extends pulumi.ComponentResource {
  readonly ipv4Address: pulumi.Output<string>;
  readonly vpsWgPublicKey: pulumi.Output<string>;
  readonly homeWgPrivateKey: pulumi.Output<string>;
  readonly homeWgPublicKey: pulumi.Output<string>;
  readonly relayAuthSecret: pulumi.Output<string>;
  readonly relayAddress: pulumi.Output<string>;
  readonly stunAddress: pulumi.Output<string>;

  constructor() {
    super("vps:VpsServer", "vps");

    const config = new pulumi.Config();
    const domain = config.require("domain");

    const opField = makeOpField({ parent: this });

    const hcloudToken = opField("Hetzner API Token");
    const cloudflareApiToken = opField("Cloudflare Api Token (DnsEdit)");

    // ---------------------------------------------------------------------------
    // Secrets
    // ---------------------------------------------------------------------------

    const relaySecret = new random.RandomPassword(
      "relay-auth-secret",
      { length: 32, special: false },
      { parent: this },
    );

    // ---------------------------------------------------------------------------
    // WireGuard keypairs
    // ---------------------------------------------------------------------------

    const vpsKeys = new command.local.Command(
      "wg-vps-keypair",
      { create: wgKeygenScript, logging: "none" },
      {
        parent: this,
        additionalSecretOutputs: ["stdout"],
      },
    );
    const homeKeys = new command.local.Command(
      "wg-home-keypair",
      { create: wgKeygenScript, logging: "none" },
      {
        parent: this,
        additionalSecretOutputs: ["stdout"],
      },
    );

    // ---------------------------------------------------------------------------
    // Ignition config (Flatcar first-boot provisioning)
    // ---------------------------------------------------------------------------

    const ignitionConfig = buildIgnitionConfig({
      vpsPrivateKey: vpsKeys.stdout.apply((s) => s.split("|")[0]),
      homePubKey: homeKeys.stdout.apply((s) => s.split("|")[1]),
      relayAuthSecret: relaySecret.result,
      domain: `netbird.${domain}`,
      relayPort,
    });

    // ---------------------------------------------------------------------------
    // Hetzner server
    // ---------------------------------------------------------------------------

    const hcloudProvider = new hcloud.Provider(
      "hcloud",
      { token: hcloudToken },
      { parent: this },
    );
    const providerOpts = { provider: hcloudProvider, parent: this };

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
            // WireGuard peers roam across networks, so source IP restriction
            // is not practical. Authentication is handled by keypairs.
            description: "WireGuard (peers authenticate by keypair)",
          },
        ],
      },
      { ...providerOpts },
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
      {
        ...providerOpts,
        replaceOnChanges: ["userData"],
      },
    );

    // ---------------------------------------------------------------------------
    // DNS
    // ---------------------------------------------------------------------------

    const cloudflareProvider = new cloudflare.Provider(
      "cloudflare",
      { apiToken: cloudflareApiToken },
      { parent: this },
    );

    const cloudflareZone = cloudflare.getZoneOutput(
      { filter: { name: domain } },
      { provider: cloudflareProvider, parent: this },
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
      {
        provider: cloudflareProvider,
        parent: this,
      },
    );

    // ---------------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------------

    this.ipv4Address = server.ipv4Address;
    this.vpsWgPublicKey = vpsKeys.stdout.apply((s) => s.split("|")[1]);
    this.homeWgPrivateKey = pulumi.secret(
      homeKeys.stdout.apply((s) => s.split("|")[0]),
    );
    this.homeWgPublicKey = homeKeys.stdout.apply((s) => s.split("|")[1]);
    this.relayAuthSecret = pulumi.secret(relaySecret.result);
    this.relayAddress = pulumi.interpolate`rels://netbird.${domain}:${relayPort}`;
    this.stunAddress = pulumi.interpolate`stun:netbird.${domain}:3478`;
  }
}
