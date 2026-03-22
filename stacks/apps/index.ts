import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { deployHomeAutomation } from "./home-automation";

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

deployHomeAutomation({ provider: k8sProvider, storageClassName });
