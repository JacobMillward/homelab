import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config();
const talosStack = new pulumi.StackReference(config.require("talosStackRef"));
const kubeconfig = talosStack.requireOutput("kubeconfigRaw").apply(v => v as string);

const k8sProvider = new k8s.Provider("k8s-provider", { kubeconfig });

// Platform services (cert-manager, metallb, traefik, etc.) will be added here
