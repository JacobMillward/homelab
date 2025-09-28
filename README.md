# Homelab

This repository contains configuration files and scripts for managing my homelab environment.

Currently, it is set up to use Talos Linux as the operating system for the cluster nodes, with Kubernetes managed by FluxCD.

This repo uses talhelper to manage the Talos cluster configuration.

# Bootstrapping the cluster
To bootstrap the Talos cluster, follow these steps:
1. Install Talos on each node using the Talos ISO or USB image.
2. Generate the machine configuration using `talhelper genconfig`.
3. Apply the Talos configuration to each node (currently one node only) using `talosctl apply-config -n <node-ip> --insecure --file clusterconfig/homelab-main.yaml`.
4. Generate and set the Talos config using `just talosconfig`.
5. Bootstrap the Kubernetes cluster using `talhelper gencommand bootstrap | bash`.
6. Bootstrap FluxCD using `flux bootstrap github --owner=JacobMillward --repository=homelab --branch=main --path=clusters/homelab --personal`.
7. Ensure there is a secret in the `flux-system` namespace called `sops-age` containing the private key for SOPS.
  e.g. `kubectl create secret generic sops-age --from-file=age.key=~/.config/sops/age/keys.txt -n flux-system`

# SOPs
This repository uses SOPs for managing secrets. The public key is available in the `.sops.yaml` file, and the private key is manually put in the cluster as a secret named `sops-age` in the `flux-system` namespace. Files encrypted with SOPs have the `.sops.yaml` suffix.

# Justfile

This contains tasks for managing the homelab setup using `just`.

## Recipes
- `talosconfig`: Generates the talosconfig file for the Talos cluster and sets it as the current context.
- `kubeconfig`: Generates the kubeconfig file for accessing the Talos cluster. Requires a valid talosconfig file.
- `talosUpgrade`: Upgrades the Talos cluster to the latest version.

## Talos Upgrades
To upgrade the Talos cluster, run the `talosUpgrade` recipe. This ensures that the Talos nodes are updated to the version in `talconfig.yaml`. Notably, it also ensures the `--preserve` flag is used which prevents the loss of the longhorn replica data on each node.