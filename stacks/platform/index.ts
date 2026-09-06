import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { makePlatformCtx } from "./context";
import { Longhorn } from "./longhorn";
import { MetalLB } from "./metallb";
import { CertManager } from "./cert-manager";
import { Traefik } from "./traefik";
import { PostgreSQL } from "./postgresql";
import { setupNetbird } from "./netbird";
import { Synology } from "./synology";
import { Authelia } from "./authelia";
import { CrowdSec } from "./crowdsec";

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
const crowdsec = new CrowdSec(ctx, { storageClassName: longhorn.storageClassName });
const traefik = new Traefik(ctx, { crowdsecBouncerApiKey: crowdsec.bouncerApiKey });
new PostgreSQL(ctx);
const synology = new Synology(ctx);
const authelia = new Authelia(ctx, {
  domain: config.require("domain"),
  storageClassName: longhorn.storageClassName,
});

const vps = new pulumi.StackReference(config.require("vpsStackRef"));

function requireVpsOutput(
  ref: pulumi.StackReference,
  key: string,
): pulumi.Output<string> {
  return ref.getOutput(key).apply((v) => {
    if (!v)
      throw new Error(`vpsStackRef is set but "${key}" is missing. Deploy VPS first (just up vps).`);
    return v as string;
  });
}

const vpsConfig = {
  ip: requireVpsOutput(vps, "vpsIp"),
  wgPublicKey: requireVpsOutput(vps, "vpsWgPublicKey"),
  homeWgPrivateKey: requireVpsOutput(vps, "homeWgPrivateKey"),
  relayAuthSecret: requireVpsOutput(vps, "relayAuthSecret"),
  relayAddress: requireVpsOutput(vps, "relayAddress"),
  stunAddress: requireVpsOutput(vps, "stunAddress"),
};

const netbird = setupNetbird({
  ctx,
  storageClassName: longhorn.storageClassName,
  traefikIp: traefik.loadBalancerIp,
  traefikInternalIp: traefik.internalIp,
  vps: vpsConfig,
  netbirdOidcClientId: authelia.netbirdOidcClientId,
  netbirdOidcClientSecret: authelia.netbirdOidcClientSecret,
});

export { storageClassName } from "./longhorn";
export const relayAuthSecret = netbird.relayAuthSecret;
export const netbirdDnsZoneId = netbird.dnsZoneId;
export const netbirdManagementUrl = netbird.managementUrl;
export const netbirdPat = netbird.pat;
export const traefikIp = traefik.loadBalancerIp;
export const traefikInternalIp = traefik.internalIp;
export const synologyPvNames = synology.pvNames;
export const autheliaServiceName = authelia.serviceName;
export const autheliaNamespace = authelia.namespace.metadata.name;
export const netbirdOidcClientId = authelia.netbirdOidcClientId;
export const netbirdOidcClientSecret = authelia.netbirdOidcClientSecret;
export const forwardAuthMiddlewareRef = traefik.forwardAuthMiddlewareRef;
export const vpsIp = vpsConfig.ip;

