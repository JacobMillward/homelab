# Homelab

This repository contains configuration files and scripts for managing my homelab environment.

# Justfile

This contains tasks for managing the homelab setup using `just`.

## Recipes
- `talosconfig`: Generates the talosconfig file for the Talos cluster using the secrets in 1Password. Completely replaces the existing talosconfig file if it exists.
- `kubeconfig`: Generates the kubeconfig file for accessing the Talos cluster. Requires a valid talosconfig file.