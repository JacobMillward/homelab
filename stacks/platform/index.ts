import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { deployLonghorn, storageClassName } from "./longhorn";
import { deployMetallb } from "./metallb";

const config = new pulumi.Config();
const talosStack = new pulumi.StackReference(config.require("talosStackRef"));
const kubeconfig = talosStack
  .requireOutput("kubeconfigRaw")
  .apply((v) => v as string);

const k8sProvider = new k8s.Provider("k8s-provider", { kubeconfig });

deployLonghorn(k8sProvider);
deployMetallb(k8sProvider);

export { storageClassName };
