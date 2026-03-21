import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as talos from "@pulumiverse/talos";
import * as command from "@pulumi/command";
import { Node } from "../../lib/types";

const config = new pulumi.Config();
const clusterName = config.require("clusterName");
const clusterEndpoint = config.require("clusterEndpoint");
const talosVersion = config.require("talosVersion");
const kubernetesVersion = config.require("kubernetesVersion");
const nodes = config.requireObject<Node[]>("nodes");

const controlPlaneNodes = nodes.filter(n => n.machineType === "controlplane");
const firstCp = controlPlaneNodes[0];

// --- Cluster-wide resources ---

const secrets = new talos.machine.Secrets("secrets", { talosVersion });

export const talosconfigRaw = pulumi.interpolate`context: ${clusterName}
contexts:
  ${clusterName}:
    endpoints:
${nodes.map(n => `      - ${n.ip}`).join("\n")}
    ca: ${secrets.clientConfiguration.caCertificate}
    crt: ${secrets.clientConfiguration.clientCertificate}
    key: ${secrets.clientConfiguration.clientKey}
`;

// --- Schematics (deduplicated) ---

const schematics = new Map<string, talos.imageFactory.Schematic>();
for (const node of nodes) {
    if (!schematics.has(node.schematic)) {
        const yamlContent = fs.readFileSync(
            path.resolve(__dirname, `../../talos/schematics/${node.schematic}.yaml`),
            "utf-8",
        );
        schematics.set(node.schematic, new talos.imageFactory.Schematic(`schematic-${node.schematic}`, {
            schematic: yamlContent,
        }));
    }
}

// --- Machine configs (one per machineType) ---

const machineTypes = [...new Set(nodes.map(n => n.machineType))];
const machineConfigs = new Map<string, pulumi.Output<talos.machine.GetConfigurationResult>>();

for (const mt of machineTypes) {
    const patches: pulumi.Input<string>[] = [
        `machine:
  kubelet:
    extraArgs:
      rotate-server-certificates: true`,
        `cluster:
  extraManifests:
    - https://raw.githubusercontent.com/alex1989hu/kubelet-serving-cert-approver/main/deploy/standalone-install.yaml
    - https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`,
    ];

    if (mt === "controlplane") {
        patches.push(`cluster:
  allowSchedulingOnControlPlanes: true`);
    }

    machineConfigs.set(mt, talos.machine.getConfigurationOutput({
        clusterName,
        clusterEndpoint,
        machineType: mt,
        machineSecrets: secrets.machineSecrets,
        talosVersion,
        kubernetesVersion,
        configPatches: patches,
    }));
}

// --- Per-node resources ---

const configApplies: talos.machine.ConfigurationApply[] = [];
const talosUpgrades: command.local.Command[] = [];

const talosUpgradeScript = `
    TMPFILE=$(mktemp)
    trap 'rm -f "$TMPFILE"' EXIT
    printf '%s' "$TALOS_CONFIG" > "$TMPFILE"
    CURRENT=$(talosctl version --talosconfig "$TMPFILE" --nodes "$NODE_IP" 2>/dev/null | awk '/Server:/{found=1} found && /Tag:/{print $2; exit}')
    if [ "$CURRENT" = "$TALOS_VERSION" ]; then echo "talos: $CURRENT (up to date)"; exit 0; fi
    echo "talos: $CURRENT -> $TALOS_VERSION"
    talosctl upgrade --talosconfig "$TMPFILE" --nodes "$NODE_IP" --image "$UPGRADE_IMAGE" --preserve
`;

for (const node of nodes) {
    const schematic = schematics.get(node.schematic)!;
    const installerUrl = talos.imageFactory.getUrlsOutput({
        schematicId: schematic.id,
        talosVersion,
        platform: "metal",
    });

    const mc = machineConfigs.get(node.machineType)!;

    const ca = new talos.machine.ConfigurationApply(`config-apply-${node.name}`, {
        clientConfiguration: secrets.clientConfiguration,
        machineConfigurationInput: mc.machineConfiguration,
        node: node.ip,
        configPatches: [
            pulumi.interpolate`machine:
  install:
    disk: ${node.installDisk}
    image: ${installerUrl.urls.installer}`,
        ],
    });
    configApplies.push(ca);
}

// --- Bootstrap (first CP only) ---

const bootstrap = new talos.machine.Bootstrap("bootstrap", {
    clientConfiguration: secrets.clientConfiguration,
    node: firstCp.ip,
}, { dependsOn: configApplies });

// --- Talos upgrades (per-node, after bootstrap) ---

for (const node of nodes) {
    const schematic = schematics.get(node.schematic)!;
    const installerUrl = talos.imageFactory.getUrlsOutput({
        schematicId: schematic.id,
        talosVersion,
        platform: "metal",
    });

    const up = new command.local.Command(`talos-upgrade-${node.name}`, {
        create: talosUpgradeScript,
        environment: {
            TALOS_CONFIG: talosconfigRaw,
            NODE_IP: node.ip,
            TALOS_VERSION: talosVersion,
            UPGRADE_IMAGE: installerUrl.urls.installer,
        },
        triggers: [talosVersion, schematic.id],
    }, { dependsOn: [bootstrap] });
    talosUpgrades.push(up);
}

// --- K8s upgrade (per-cluster, after all talos upgrades) ---

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
        NODE_IP: firstCp.ip,
        K8S_VERSION: kubernetesVersion,
    },
    triggers: [kubernetesVersion],
}, { dependsOn: talosUpgrades });

// --- Kubeconfig ---

const kubeconfig = new talos.cluster.Kubeconfig("kubeconfig", {
    clientConfiguration: secrets.clientConfiguration,
    node: firstCp.ip,
}, { dependsOn: [k8sUpgrade] });

export const kubeconfigRaw = kubeconfig.kubeconfigRaw;
