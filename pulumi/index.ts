import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as talos from "@pulumiverse/talos";
import * as command from "@pulumi/command";

const config = new pulumi.Config();
const nodeIp = config.require("nodeIp");
const clusterEndpoint = config.require("clusterEndpoint");
const talosVersion = config.require("talosVersion");
const kubernetesVersion = config.require("kubernetesVersion");
const installDisk = config.require("installDisk");
const talosSchematicId = config.require("talosSchematicId");

const secrets = new talos.machine.Secrets("secrets", { talosVersion });

export const talosconfigRaw = pulumi.interpolate`context: homelab
contexts:
  homelab:
    endpoints:
      - ${nodeIp}
    ca: ${secrets.clientConfiguration.caCertificate}
    crt: ${secrets.clientConfiguration.clientCertificate}
    key: ${secrets.clientConfiguration.clientKey}
`;

const machineConfig = talos.machine.getConfigurationOutput({
    clusterName: "homelab",
    clusterEndpoint,
    machineType: "controlplane",
    machineSecrets: secrets.machineSecrets,
    talosVersion,
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

const talosUpgradeScript = `
    TMPFILE=$(mktemp)
    trap 'rm -f "$TMPFILE"' EXIT
    printf '%s' "$TALOS_CONFIG" > "$TMPFILE"
    CURRENT=$(talosctl version --talosconfig "$TMPFILE" --nodes "$NODE_IP" 2>/dev/null | awk '/Server:/{found=1} found && /Tag:/{print $2; exit}')
    if [ "$CURRENT" = "$TALOS_VERSION" ]; then echo "talos: $CURRENT (up to date)"; exit 0; fi
    echo "talos: $CURRENT -> $TALOS_VERSION"
    talosctl upgrade --talosconfig "$TMPFILE" --nodes "$NODE_IP" --image "$UPGRADE_IMAGE" --preserve
`;

const upgrade = new command.local.Command("talos-upgrade", {
    create: talosUpgradeScript,
    environment: {
        TALOS_CONFIG: talosconfigRaw,
        NODE_IP: nodeIp,
        TALOS_VERSION: talosVersion,
        UPGRADE_IMAGE: `factory.talos.dev/installer/${talosSchematicId}:${talosVersion}`,
    },
    triggers: [talosVersion, talosSchematicId],
}, { dependsOn: [bootstrap] });

const k8sUpgradeScript = `
    TMPFILE=$(mktemp)
    KUBECFG=$(mktemp)
    trap 'rm -f "$TMPFILE" "$KUBECFG"' EXIT
    printf '%s' "$TALOS_CONFIG" > "$TMPFILE"
    talosctl kubeconfig "$KUBECFG" --talosconfig "$TMPFILE" --nodes "$NODE_IP" --force 2>/dev/null
    CURRENT=$(kubectl --kubeconfig "$KUBECFG" version -o json 2>/dev/null | jq -r '.serverVersion.gitVersion')
    if [ "$CURRENT" = "$K8S_VERSION" ]; then echo "k8s: $CURRENT (up to date)"; exit 0; fi
    echo "k8s: $CURRENT -> $K8S_VERSION"
    talosctl upgrade-k8s --talosconfig "$TMPFILE" --nodes "$NODE_IP" --to "$K8S_VERSION"
`;

const k8sUpgrade = new command.local.Command("k8s-upgrade", {
    create: k8sUpgradeScript,
    environment: {
        TALOS_CONFIG: talosconfigRaw,
        NODE_IP: nodeIp,
        K8S_VERSION: kubernetesVersion,
    },
    triggers: [kubernetesVersion],
}, { dependsOn: [upgrade] });

const kubeconfig = new talos.cluster.Kubeconfig("kubeconfig", {
    clientConfiguration: secrets.clientConfiguration,
    node: nodeIp,
}, { dependsOn: [k8sUpgrade] });

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
