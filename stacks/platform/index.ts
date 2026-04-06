import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as onepassword from "@1password/pulumi-onepassword";
import { deployLonghorn, storageClassName } from "./longhorn";
import { deployMetallb } from "./metallb";
import { deployCertManager } from "./cert-manager";
import { deployTraefik } from "./traefik";
import { deployPostgresql } from "./postgresql";
import { setupNetbird } from "./netbird";

const config = new pulumi.Config();
const talosStack = new pulumi.StackReference(config.require("talosStackRef"));
const kubeconfig = talosStack
  .requireOutput("kubeconfigRaw")
  .apply((v) => v as string);

const k8sProvider = new k8s.Provider("k8s-provider", { kubeconfig });

// 1Password secrets
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

deployLonghorn(k8sProvider);
deployMetallb(k8sProvider);
deployCertManager(k8sProvider, opField("Cloudflare Api Token (DnsEdit)"));
const traefik = deployTraefik(k8sProvider);

deployPostgresql(k8sProvider);

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
  k8sProvider,
  storageClassName,
  traefikIp: traefik.loadBalancerIp,
  vps: vpsConfig,
});

export { storageClassName };
export const relayAuthSecret = netbird.relayAuthSecret;
export const netbirdDnsZoneId = netbird.dnsZoneId;
export const netbirdManagementUrl = netbird.managementUrl;
export const netbirdPat = netbird.pat;
export const traefikIp = traefik.loadBalancerIp;
export const traefikInternalIp = traefik.internalIp;
