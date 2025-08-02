[private]
default:
  @just --list

# Generate a Talosconfig and set it as the current context
talosconfig:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Generating Talos configuration..."
    talhelper genconfig
    talosctl config merge clusterconfig/talosconfig
    talosctl config context homelab
    talosctl config remove homelab-1 -y || true

# Generate a kubeconfig for Talos. Requires a valid Talos context
kubeconfig:
    #!/usr/bin/env bash
    echo "Generating kubeconfig..."
    talosctl kubeconfig --force
    echo "Kubeconfig generated successfully."