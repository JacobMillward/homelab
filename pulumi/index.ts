import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as talos from "@pulumiverse/talos";

const config = new pulumi.Config();
const nodeIp = config.require("nodeIp");
const clusterEndpoint = config.require("clusterEndpoint");
const talosVersion = config.require("talosVersion");
const nodeVersion = config.get("nodeVersion") ?? talosVersion;
const kubernetesVersion = config.require("kubernetesVersion");
const installDisk = config.require("installDisk");
const talosSchematicId = config.require("talosSchematicId");

const secrets = new talos.machine.Secrets("secrets", { talosVersion });

const machineConfig = talos.machine.getConfigurationOutput({
    clusterName: "homelab",
    clusterEndpoint,
    machineType: "controlplane",
    machineSecrets: secrets.machineSecrets,
    talosVersion: nodeVersion,
    kubernetesVersion,
    configPatches: [
        pulumi.interpolate`machine:
  install:
    disk: ${installDisk}
    image: factory.talos.dev/installer/${talosSchematicId}:${talosVersion}`,
        `machine:
  kubelet:
    extraArgs:
      rotate-server-certificates: true`,
        `cluster:
  allowSchedulingOnControlPlanes: true`,
        `cluster:
  extraManifests:
    - https://raw.githubusercontent.com/alex1989hu/kubelet-serving-cert-approver/main/deploy/standalone-install.yaml
    - https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`,
    ],
});

const configApply = new talos.machine.ConfigurationApply("config-apply", {
    clientConfiguration: secrets.clientConfiguration,
    machineConfigurationInput: machineConfig.machineConfiguration,
    node: nodeIp,
});

const bootstrap = new talos.machine.Bootstrap("bootstrap", {
    clientConfiguration: secrets.clientConfiguration,
    node: nodeIp,
}, { dependsOn: [configApply] });

const kubeconfig = new talos.cluster.Kubeconfig("kubeconfig", {
    clientConfiguration: secrets.clientConfiguration,
    node: nodeIp,
}, { dependsOn: [bootstrap] });

const k8sProvider = new k8s.Provider("k8s-provider", {
    kubeconfig: kubeconfig.kubeconfigRaw,
});

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

export const kubeconfigRaw = kubeconfig.kubeconfigRaw;
