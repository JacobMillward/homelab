import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config();
const talosStack = new pulumi.StackReference(config.require("talosStackRef"));
const _platformStack = new pulumi.StackReference(config.require("platformStackRef"));

const kubeconfig = talosStack.requireOutput("kubeconfigRaw").apply(v => v as string);
const k8sProvider = new k8s.Provider("k8s-provider", { kubeconfig });

const ns = new k8s.core.v1.Namespace("hello-world", {
    metadata: { name: "hello-world" },
}, { provider: k8sProvider });

new k8s.apps.v1.Deployment("hello-world", {
    metadata: {
        name: "hello-world",
        namespace: ns.metadata.name,
    },
    spec: {
        replicas: 1,
        selector: { matchLabels: { app: "hello-world" } },
        template: {
            metadata: { labels: { app: "hello-world" } },
            spec: {
                containers: [{
                    name: "nginx",
                    image: "nginx:alpine",
                    ports: [{ containerPort: 80 }],
                }],
            },
        },
    },
}, { provider: k8sProvider });
