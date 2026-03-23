import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { deployHomeAutomation } from "./home-automation";
import { DnsRegistrar } from "./dns";

const config = new pulumi.Config();
const talosStack = new pulumi.StackReference(config.require("talosStackRef"));
const platformStack = new pulumi.StackReference(
  config.require("platformStackRef"),
);

const kubeconfig = talosStack
  .requireOutput("kubeconfigRaw")
  .apply((v) => v as string);
const storageClassName = platformStack
  .requireOutput("storageClassName")
  .apply((v) => v as string);

const k8sProvider = new k8s.Provider("k8s-provider", { kubeconfig });

const dns = new DnsRegistrar({
  managementUrl: platformStack
    .requireOutput("netbirdManagementUrl")
    .apply((v) => v as string),
  pat: platformStack.requireOutput("netbirdPat").apply((v) => v as string),
  dnsZoneId: platformStack
    .requireOutput("netbirdDnsZoneId")
    .apply((v) => v as string),
});

deployHomeAutomation({ provider: k8sProvider, storageClassName, dns });
