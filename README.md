# Homelab

This repository contains configuration files and scripts for managing my homelab environment.

Currently, it is set up to use Talos Linux as the operating system for the cluster nodes, with Kubernetes managed by FluxCD.

This repo uses talhelper to manage the Talos cluster configuration.

# SOPs
This repository uses SOPs for managing secrets. The public key is available in the `.sops.yaml` file, and the private key is manually put in the cluster as a secret named `sops-age` in the `flux-system` namespace.

# Justfile

This contains tasks for managing the homelab setup using `just`.

## Recipes
- `talosconfig`: Generates the talosconfig file for the Talos cluster and sets it as the current context.
- `kubeconfig`: Generates the kubeconfig file for accessing the Talos cluster. Requires a valid talosconfig file.
- `talosUpgrade`: Upgrades the Talos cluster to the latest version.

## Talos Upgrades
To upgrade the Talos cluster, run the `talosUpgrade` recipe. This ensures that the Talos nodes are updated to the version in `talconfig.yaml`. Notably, it also ensures the `--preserve` flag is used which prevents the loss of the longhorn replica data on each node.