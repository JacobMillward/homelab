export PULUMI_BACKEND_URL := "file://" + justfile_directory() / ".pulumi"

# List of stacks to manage
# Order matters, stacks are initialized and deployed in order

stacks := "talos platform apps"

[private]
default:
    @just --list

# Run a pulumi command for a given stack
pulumi STACK *args:
    cd stacks/{{ STACK }} && op run --env-file={{ justfile_directory() }}/.env -- pulumi {{ args }}

# Install dependencies for all stacks
install:
    #!/usr/bin/env bash
    set -euo pipefail
    for s in {{ stacks }}; do
      echo "==> Installing $s"
      cd stacks/$s && pnpm install && cd ../..
    done

# Initialize all Pulumi stacks (run once)
init:
    #!/usr/bin/env bash
    set -euo pipefail
    for s in {{ stacks }}; do just pulumi $s stack init homelab; done

# Preview changes (all stacks, or just one)
preview STACK="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{ STACK }}" ]; then just pulumi "{{ STACK }}" preview
    else for s in {{ stacks }}; do just pulumi "$s" preview; done; fi

# Deploy (all stacks in order, or just one)
up STACK="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{ STACK }}" ]; then just pulumi "{{ STACK }}" up --yes
    else for s in {{ stacks }}; do just pulumi "$s" up --yes; done; fi

# Destroy (all stacks in reverse order, or just one)
destroy STACK="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{ STACK }}" ]; then just pulumi "{{ STACK }}" destroy
    else for s in apps platform talos; do just pulumi "$s" destroy; done; fi

# Export kubeconfig to ~/.kube/config
kubeconfig:
    just pulumi talos stack output kubeconfigRaw --show-secrets > ~/.kube/config

# Export talosconfig to ~/.talos/config
talosconfig:
    just pulumi talos stack output talosconfigRaw --show-secrets > ~/.talos/config
