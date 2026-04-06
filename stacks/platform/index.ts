import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { makePlatformCtx } from "./context";
import { Longhorn } from "./longhorn";
import { MetalLB } from "./metallb";
import { CertManager } from "./cert-manager";
import { Traefik } from "./traefik";
import { PostgreSQL } from "./postgresql";
import { setupNetbird } from "./netbird";

const config = new pulumi.Config();
const talosStack = new pulumi.StackReference(config.require("talosStackRef"));
const kubeconfig = talosStack
  .requireOutput("kubeconfigRaw")
  .apply((v) => v as string);

const k8sProvider = new k8s.Provider("k8s-provider", { kubeconfig });
const ctx = makePlatformCtx(k8sProvider);

const longhorn = new Longhorn(ctx);
new MetalLB(ctx);
new CertManager(ctx);
const traefik = new Traefik(ctx);
new PostgreSQL(ctx);

// Optional VPS integration. When vpsStackRef is set, the platform deploys a
// WireGuard peer and switches to the VPS-hosted relay/STUN. Without it,
// everything runs locally with the embedded relay (existing behavior).
const vpsRef = config.get("vpsStackRef");
const vps = vpsRef ? new pulumi.StackReference(vpsRef) : undefined;

function requireVpsOutput(
  ref: pulumi.StackReference,
  key: string,
): pulumi.Output<string> {
  return ref.getOutput(key).apply((v) => {
    if (!v)
      throw new Error(
        `vpsStackRef is set but "${key}" is missing. ` +
          `Deploy VPS first (just up vps) or remove the ref ` +
          `(just pulumi platform config rm vpsStackRef).`,
      );
    return v as string;
  });
}

const vpsConfig = vps
  ? {
      ip: requireVpsOutput(vps, "vpsIp"),
      wgPublicKey: requireVpsOutput(vps, "vpsWgPublicKey"),
      homeWgPrivateKey: requireVpsOutput(vps, "homeWgPrivateKey"),
      relayAuthSecret: requireVpsOutput(vps, "relayAuthSecret"),
      relayAddress: requireVpsOutput(vps, "relayAddress"),
      stunAddress: requireVpsOutput(vps, "stunAddress"),
    }
  : undefined;

const netbird = setupNetbird({
  ctx,
  storageClassName: longhorn.storageClassName,
  traefikIp: traefik.loadBalancerIp,
  vps: vpsConfig,
});

export { storageClassName } from "./longhorn";
export const relayAuthSecret = netbird.relayAuthSecret;
export const netbirdDnsZoneId = netbird.dnsZoneId;
export const netbirdManagementUrl = netbird.managementUrl;
export const netbirdPat = netbird.pat;
export const traefikIp = traefik.loadBalancerIp;
export const traefikInternalIp = traefik.internalIp;

