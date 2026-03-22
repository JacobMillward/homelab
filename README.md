# Homelab

This repository contains configuration files and scripts for managing my homelab environment.

It uses [Talos Linux](https://www.talos.dev/) as the OS for cluster nodes, with infrastructure managed by [Pulumi](https://www.pulumi.com/) (TypeScript).

## Structure

```
stacks/
  talos/       Cluster bootstrap and lifecycle (Talos + K8s upgrades)
  platform/    Infrastructure services (cert-manager, metallb, etc.)
  apps/        User applications
lib/           Shared TypeScript types
```

## Prerequisites

- [Pulumi CLI](https://www.pulumi.com/docs/install/)
- [1Password CLI](https://developer.1password.com/docs/cli/) (`op`)
- [just](https://github.com/casey/just)
- [pnpm](https://pnpm.io/)
- [talosctl](https://www.talos.dev/latest/talos-guides/install/talosctl/)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)

## Getting started

Install dependencies and initialise the Pulumi stacks:

```bash
just install    # Install pnpm dependencies for all stacks
just init       # Initialise Pulumi stacks (run once)
```

## Justfile recipes

- `just up`: Deploy all stacks in order (talos → platform → apps)
- `just up talos`: Deploy a single stack
- `just preview`: Preview changes across all stacks
- `just preview talos`: Preview a single stack
- `just destroy`: Destroy all stacks in reverse order
- `just pulumi talos <command>`: Run any Pulumi command against a stack
- `just kubeconfig`: Export kubeconfig to `kubeconfig.yaml`
- `just talosconfig`: Export talosconfig to `talosconfig.yaml`

## Adding a node

1. Create a schematic YAML if new hardware: `stacks/talos/schematics/<name>.yaml`
2. Add an entry to `stacks/talos/Pulumi.homelab.yaml` under `nodes`
3. Boot the node from the Talos ISO
4. Run `just up talos`

## Upgrades

Talos and Kubernetes versions are configured in `stacks/talos/Pulumi.homelab.yaml`. Bumping the version and running `just up talos` will upgrade the cluster. The upgrade scripts short-circuit if the running version already matches the target, so re-runs are safe and fast.
