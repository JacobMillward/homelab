export PULUMI_BACKEND_URL := "file://" + justfile_directory() / ".pulumi"
stacks := "talos platform apps"

[private]
default:
    @just --list

# Private helper: run a pulumi command for a given stack
[private]
_pulumi STACK *args:
    cd stacks/{{ STACK }} && op run --env-file={{ justfile_directory() }}/.env -- pulumi {{ args }}

# Install dependencies for all stacks
install:
    #!/usr/bin/env bash
    set -euo pipefail
    for s in {{ stacks }}; do
      echo "==> Installing $s"
      cd stacks/$s && bun install && cd ../..
    done

# Initialize all Pulumi stacks (run once)
init:
    #!/usr/bin/env bash
    set -euo pipefail
    for s in {{ stacks }}; do just _pulumi $s stack init homelab; done

# Preview changes (all stacks, or just one)
preview STACK="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{ STACK }}" ]; then just _pulumi "{{ STACK }}" preview
    else for s in {{ stacks }}; do just _pulumi "$s" preview; done; fi

# Deploy (all stacks in order, or just one)
up STACK="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{ STACK }}" ]; then just _pulumi "{{ STACK }}" up --yes
    else for s in {{ stacks }}; do just _pulumi "$s" up --yes; done; fi

# Destroy (all stacks in reverse order, or just one)
destroy STACK="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{ STACK }}" ]; then just _pulumi "{{ STACK }}" destroy
    else for s in apps platform talos; do just _pulumi "$s" destroy; done; fi

# Export kubeconfig to kubeconfig.yaml
kubeconfig:
    just _pulumi talos stack output kubeconfigRaw --show-secrets > kubeconfig.yaml

# Export talosconfig to talosconfig.yaml
talosconfig:
    just _pulumi talos stack output talosconfigRaw --show-secrets > talosconfig.yaml
