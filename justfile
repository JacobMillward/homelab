[private]
default:
  @just --list

# Generate a Talosconfig and set it as the current context.
# If a context already exists called 'homelab', it will be removed.
talosconfig:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "Generating Talos configuration..."
    talhelper genconfig
    talosctl config merge clusterconfig/talosconfig
    talosctl config remove homelab -y || true
    talosctl config merge clusterconfig/talosconfig
    talosctl config remove homelab-1 -y || true

# Generate a kubeconfig for Talos. Requires a valid Talos context
kubeconfig:
    #!/usr/bin/env bash
    echo "Generating kubeconfig..."
    talosctl kubeconfig --force
    echo "Kubeconfig generated successfully."

# Helper for Talos upgrades. Ensures we pass the --preserve flag so as to not lose longhorn replica data
talosUpgrade:
    talhelper gencommand upgrade --extra-flags "--preserve" | bash