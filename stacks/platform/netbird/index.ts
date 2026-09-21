import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as netbird from "@pulumi/netbird";
import * as crypto from "crypto";
import { DOMAIN } from "homelab-lib";
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

  // Dex reads Authelia's client_id/secret from its own sqlite store (set by
  // identityProvider above) but doesn't hot-reload it on a rotation. A
  // separate patch, applied only after identityProvider, restarts the pod
  // without creating a cycle (identityProvider itself depends on the
  // Deployment already existing).
  const oidcConfigHash = pulumi
    .all([netbirdOidcClientId, netbirdOidcClientSecret])
    .apply(([id, secret]) => crypto.createHash("sha256").update(`${id}:${secret}`).digest("hex"));

  new k8s.apps.v1.DeploymentPatch(
    "netbird-server-oidc-restart",
    {
      metadata: {
        name: server.serverDeployment.metadata.name,
        namespace: server.serverDeployment.metadata.namespace,
      },
      spec: {
        template: {
          metadata: { annotations: { "homelab.internal/oidc-config-hash": oidcConfigHash } },
        },
      },
    },
    { provider: ctx.k8sProvider, dependsOn: [nbConfig.identityProvider] },
  );

  // Dashboard is mesh-only (traefik-internal) — give mesh peers a NetBird
  // DNS record for it, same as any other internal app.
  new netbird.DnsRecord(
    "netbird-dashboard-dns",
    {
      name: `dashboard.internal.${DOMAIN}`,
      zoneId: nbConfig.dnsZoneId,
      type: "A",
      content: traefikInternalIp,
      ttl: 300,
    },
    { provider: nbProvider },
  );

  // Registry is mesh-only too, same target IP as the dashboard.
  const registryDns = new netbird.DnsRecord(
    "registry-internal-dns",
    {
      name: `registry.internal.${DOMAIN}`,
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
    managementUrl: `https://netbird.${DOMAIN}`,
    pat,
    registryDns,
  };
}

