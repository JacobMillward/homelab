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
import { Authelia, createOidcClient } from "./authelia";
import { CrowdSec } from "./crowdsec";
import { Renovate } from "./renovate";
import { ExternalSecrets } from "./eso";
import { PulumiOperator } from "./pko";
import { Forgejo, FORGEJO_AUTH_SOURCE_NAME } from "./forgejo";
import { Registry } from "./registry";
import { DOMAIN } from "homelab-lib";

const config = new pulumi.Config();
const cloudflareApiToken = config.requireSecret("cloudflareApiToken");
const cloudflareDnsEditApiToken = config.requireSecret("cloudflareDnsEditApiToken");

// No explicit kubeconfig — resolves in-cluster or via ~/.kube/config,
// since talos's kubeconfig is encrypted under a different passphrase.
const k8sProvider = new k8s.Provider("k8s-provider", {});
const ctx = makePlatformCtx(k8sProvider);

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
  ipv6: requireVpsOutput(vps, "vpsIpv6"),
  wgPublicKey: requireVpsOutput(vps, "vpsWgPublicKey"),
  relayAddress: requireVpsOutput(vps, "relayAddress"),
  stunAddress: requireVpsOutput(vps, "stunAddress"),
};

const eso = new ExternalSecrets(ctx, {
  onePasswordConnectCredentials: config.requireSecret("onePasswordConnectCredentials"),
  onePasswordConnectToken: config.requireSecret("onePasswordConnectToken"),
  homelabVaultId: config.require("homelabVaultId"),
});

const longhorn = new Longhorn(ctx);
new MetalLB(ctx);
new CertManager(ctx, { cloudflareDnsEditApiToken });
const crowdsec = new CrowdSec(ctx, { storageClassName: longhorn.storageClassName });
const traefik = new Traefik(ctx, {
  crowdsecBouncerApiKey: crowdsec.bouncerApiKey,
  cloudflareApiToken,
  vpsIp: vpsConfig.ip,
  vpsIpv6: vpsConfig.ipv6,
});
new PostgreSQL(ctx);
const synology = new Synology(ctx);
const registry = new Registry(ctx, { domain: DOMAIN, storageClassName: longhorn.storageClassName });

const netbirdOidc = createOidcClient("netbird", {
  redirectUris: [`https://netbird.${DOMAIN}/oauth2/callback`],
  userinfoSignedResponseAlg: "none",
});
const forgejoOidc = createOidcClient("forgejo", {
  redirectUris: [`https://git.${DOMAIN}/user/oauth2/${FORGEJO_AUTH_SOURCE_NAME}/callback`],
});

const authelia = new Authelia(ctx, {
  domain: DOMAIN,
  storageClassName: longhorn.storageClassName,
  oidcClients: [netbirdOidc, forgejoOidc],
  publicDns: traefik.publicDns,
});

const netbird = setupNetbird({
  ctx,
  storageClassName: longhorn.storageClassName,
  traefikIp: traefik.loadBalancerIp,
  traefikClusterIp: traefik.clusterIp,
  traefikInternalIp: traefik.internalIp,
  forgejoSshIp: config.require("forgejoSshIp"),
  forwardAuthSpec: traefik.forwardAuthSpec,
  vps: vpsConfig,
  secretStoreName: eso.secretStoreName,
  netbirdOidcClientId: netbirdOidc.clientId,
  netbirdOidcClientSecret: netbirdOidc.clientSecret,
});

const forgejo = new Forgejo(ctx, {
  domain: DOMAIN,
  storageClassName: longhorn.storageClassName,
  oidcClient: forgejoOidc,
  sshLoadBalancerIp: config.require("forgejoSshIp"),
  crowdsecPluginSpec: traefik.crowdsecPluginSpec,
  githubMirrorToken: config.requireSecret("githubMirrorToken"),
  crowdsecFirewallBouncerApiKey: crowdsec.firewallBouncerApiKey,
  registry: {
    pushHost: registry.pushHost,
    username: registry.username,
    password: registry.password,
    dependsOn: [netbird.registryDns, registry.deployment],
  },
  publicDns: traefik.publicDns,
});

new PulumiOperator(ctx, {
  operatorNamespace: eso.operatorNamespace,
  forgejo: {
    endpoint: forgejo.endpoint,
    adminApiToken: forgejo.adminApiToken,
    repoOwner: forgejo.repoOwner,
    repoName: forgejo.repoName,
  },
});

new Renovate(ctx, {
  forgejo: {
    endpoint: forgejo.endpoint,
    adminApiToken: forgejo.adminApiToken,
    repoOwner: forgejo.repoOwner,
    repoName: forgejo.repoName,
  },
  dockerhubUsername: config.requireSecret("dockerhubUsername"),
  dockerhubToken: config.requireSecret("dockerhubToken"),
});

export { storageClassName } from "./longhorn";
export const netbirdDnsZoneId = netbird.dnsZoneId;
export const netbirdManagementUrl = netbird.managementUrl;
export const netbirdPat = netbird.pat;
export const traefikIp = traefik.loadBalancerIp;
export const traefikInternalIp = traefik.internalIp;
export const synologyPvNames = synology.pvNames;
export const autheliaServiceName = authelia.serviceName;
export const autheliaNamespace = authelia.namespace.metadata.name;
export const netbirdOidcClientId = netbirdOidc.clientId;
export const netbirdOidcClientSecret = netbirdOidc.clientSecret;
export const forwardAuthSpec = traefik.forwardAuthSpec;
export const crowdsecPluginSpec = traefik.crowdsecPluginSpec;
export const vpsIp = vpsConfig.ip;
export const forgejoServiceName = forgejo.serviceName;
export const forgejoNamespace = forgejo.namespace.metadata.name;

