import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as netbird from "@pulumi/netbird";
import { PlatformCtx } from "../context";
import { NetbirdServer } from "./server";
import { NetbirdRouter } from "./router";
import { VpsTunnel } from "./wg-peer";
import { configureNetbird } from "./config";

interface NetbirdArgs {
  ctx: PlatformCtx;
  storageClassName: string;
  traefikIp: string;
  vps?: {
    ip: pulumi.Output<string>;
    wgPublicKey: pulumi.Output<string>;
    homeWgPrivateKey: pulumi.Output<string>;
    relayAuthSecret: pulumi.Output<string>;
    relayAddress: pulumi.Output<string>;
    stunAddress: pulumi.Output<string>;
  };
}

// Orchestrates: server deploy → API config → router deploy.
// On a fresh deploy the server must be running before the NetBird
// API provider can create setup keys and network routes.
export function setupNetbird(args: NetbirdArgs) {
  const { ctx, storageClassName, traefikIp, vps } = args;
  const config = new pulumi.Config();
  const domain = config.require("domain");

  // 1. Deploy server, dashboard, and ingress
  const server = new NetbirdServer(ctx, {
    storageClassName,
    vps: vps
      ? {
          relayAuthSecret: vps.relayAuthSecret,
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

  const nbConfig = configureNetbird(nbProvider, [
    server.serverDeployment,
    server.localApiRoute,
  ]);

  // 3. Deploy the routing peer using the Pulumi-managed setup key
  new NetbirdRouter(ctx, {
    namespace: server.namespace,
    storageClassName,
    setupKey: nbConfig.setupKey,
  });

  // 4. If VPS is configured, deploy the WireGuard tunnel endpoint
  if (vps) {
    new VpsTunnel(ctx, {
      namespace: server.namespace,
      vpsIp: vps.ip,
      vpsWgPublicKey: vps.wgPublicKey,
      homeWgPrivateKey: vps.homeWgPrivateKey,
    });
  }

  return {
    relayAuthSecret: vps ? vps.relayAuthSecret : server.relayAuthSecret,
    dnsZoneId: nbConfig.dnsZoneId,
    managementUrl: `https://netbird.${domain}`,
    pat,
  };
}

