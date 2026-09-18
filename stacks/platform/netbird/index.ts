import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as netbird from "@pulumi/netbird";
import { PlatformCtx } from "../context";
import { NetbirdServer } from "./server";
import { NetbirdRouter } from "./router";
import { VpsTunnel } from "./wg-peer";
import { configureNetbird } from "./config";
import { ForwardAuthSpec } from "../traefik";

interface NetbirdArgs {
  ctx: PlatformCtx;
  storageClassName: string;
  traefikIp: string;
  traefikClusterIp: pulumi.Input<string>;
  traefikInternalIp: pulumi.Input<string>;
  forwardAuthSpec: ForwardAuthSpec;
  netbirdOidcClientId: pulumi.Input<string>;
  netbirdOidcClientSecret: pulumi.Input<string>;
  secretStoreName: pulumi.Input<string>;
  vps?: {
    ip: pulumi.Output<string>;
    wgPublicKey: pulumi.Output<string>;
    relayAddress: pulumi.Output<string>;
    stunAddress: pulumi.Output<string>;
  };
}

// Orchestrates: server deploy → API config → router deploy.
// On a fresh deploy the server must be running before the NetBird
// API provider can create setup keys and network routes.
export function setupNetbird(args: NetbirdArgs) {
  const { ctx, storageClassName, traefikIp, traefikClusterIp, traefikInternalIp, forwardAuthSpec, vps, netbirdOidcClientId, netbirdOidcClientSecret, secretStoreName } = args;
  const config = new pulumi.Config();
  const domain = config.require("domain");

  const server = new NetbirdServer(ctx, {
    storageClassName,
    traefikIp,
    forwardAuthSpec,
    secretStoreName,
    vps: vps
      ? {
          relayAddress: vps.relayAddress,
          stunAddress: vps.stunAddress,
        }
      : undefined,
  });

  // 2. Configure NetBird via API (groups, networks, DNS, setup key).
  //    Uses Traefik's LAN IP over HTTP to avoid depending on public DNS
  //    (which points to the VPS that can't proxy back until the WG tunnel
  //    is deployed by this same stack).
  const managementUrl = `http://${traefikIp}`;
  const pat = config.requireSecret("netbirdPat");

  const nbProvider = new netbird.Provider("netbird", {
    managementUrl,
    token: pat,
  });

  const nbConfig = configureNetbird(
    nbProvider,
    [server.serverDeployment, server.localApiRoute],
    { clientId: netbirdOidcClientId, clientSecret: netbirdOidcClientSecret },
  );

  // Dashboard is mesh-only (traefik-internal) — give mesh peers a NetBird
  // DNS record for it, same as any other internal app.
  new netbird.DnsRecord(
    "netbird-dashboard-dns",
    {
      name: `dashboard.internal.${domain}`,
      zoneId: nbConfig.dnsZoneId,
      type: "A",
      content: traefikInternalIp,
      ttl: 300,
    },
    { provider: nbProvider },
  );

  // 3. Deploy the routing peer using the Pulumi-managed setup key
  new NetbirdRouter(ctx, {
    namespace: server.namespace,
    storageClassName,
    setupKey: nbConfig.setupKey,
  });

  if (vps) {
    new VpsTunnel(ctx, {
      namespace: server.namespace,
      vpsIp: vps.ip,
      vpsWgPublicKey: vps.wgPublicKey,
      traefikIp: traefikClusterIp,
    });
  }

  return {
    dnsZoneId: nbConfig.dnsZoneId,
    managementUrl: `https://netbird.${domain}`,
    pat,
  };
}

