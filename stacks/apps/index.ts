import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { HomeAutomation } from "./home-automation";
import { Joplin } from "./joplin";
import { DnsRegistrar } from "./dns";
import { AppCtx } from "./app";

const config = new pulumi.Config();
const domain = config.require("domain");
const platformStack = new pulumi.StackReference(
  config.require("platformStackRef"),
);

const storageClassName = platformStack
  .requireOutput("storageClassName")
  .apply((v) => v as string);

const synologyPvNames = platformStack
  .requireOutput("synologyPvNames")
  .apply((v) => v as Record<string, string>);

// No explicit kubeconfig — see stacks/platform/index.ts for why.
const k8sProvider = new k8s.Provider("k8s-provider", {});

const traefikInternalIp = platformStack
  .requireOutput("traefikInternalIp")
  .apply((v) => v as string);

const cloudflareApiToken = config.requireSecret("cloudflareApiToken");
const vpsIp = platformStack.requireOutput("vpsIp").apply((v) => v as string);
const forwardAuthSpec = platformStack
  .requireOutput("forwardAuthSpec")
  .apply(
    (v) =>
      v as {
        address: string;
        trustForwardHeader: boolean;
        maxResponseBodySize: number;
        authResponseHeaders: string[];
      },
  );

const dns = new DnsRegistrar({
  domain,
  managementUrl: platformStack
    .requireOutput("netbirdManagementUrl")
    .apply((v) => v as string),
  pat: platformStack.requireOutput("netbirdPat").apply((v) => v as string),
  dnsZoneId: platformStack
    .requireOutput("netbirdDnsZoneId")
    .apply((v) => v as string),
  traefikInternalIp,
  cloudflareApiToken,
  vpsIp,
  forwardAuthSpec,
});

const ctx: AppCtx = {
  provider: k8sProvider,
  storageClassName,
  dns,
  synologyPvNames,
};

new HomeAutomation(ctx);
new Joplin(ctx);
