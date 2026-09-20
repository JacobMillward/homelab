# List of stacks to manage
# Order matters, stacks are initialized and deployed in order

stacks := "talos vps platform apps"

[private]
default:
    @just --list

# Run a pulumi command for a given stack
pulumi STACK *args:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{ STACK }}" in
      platform|apps)
        export PULUMI_CONFIG_PASSPHRASE=$(op read "op://Private/Homelab/Pulumi Passphrase - platform and apps")
        ;;
      talos|vps)
        export PULUMI_CONFIG_PASSPHRASE=$(op read "op://Private/Homelab/Pulumi Passphrase")
        ;;
      *)
        echo "Unknown stack: {{ STACK }}" >&2
        exit 1
        ;;
    esac
    export AWS_ACCESS_KEY_ID=$(op read "op://Private/Homelab/API Tokens/Garage Access Key ID")
    export AWS_SECRET_ACCESS_KEY=$(op read "op://Private/Homelab/API Tokens/Garage Secret Access Key")
    export PULUMI_BACKEND_URL="s3://pulumi-state?endpoint=192.168.0.40:3900&disableSSL=true&s3ForcePathStyle=true&region=garage"
    cd stacks/{{ STACK }} && pulumi {{ args }}

# Install dependencies for all stacks
install:
    pnpm install

# Regenerate stacks/{apps,platform}/sdks/netbird from Pulumi.yaml's packages.netbird
# spec (e.g. after bumping its version) and commit the result
regenerate-netbird-sdk:
    @bash scripts/generate-netbird-sdk.sh

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
    else for s in apps platform vps talos; do just pulumi "$s" destroy; done; fi

# Export kubeconfig to ~/.kube/config
kubeconfig:
    just pulumi talos stack output kubeconfigRaw --show-secrets > ~/.kube/config

# Export talosconfig to ~/.talos/config
talosconfig:
    just pulumi talos stack output talosconfigRaw --show-secrets > ~/.talos/config

# Manually trigger the Renovate CronJob to run now and tail its logs
renovate:
    #!/usr/bin/env bash
    set -euo pipefail
    job="renovate-manual-$(date +%s)"
    kubectl create job "$job" --from=cronjob/renovate -n renovate
    kubectl wait --for=condition=ready pod -l job-name="$job" -n renovate --timeout=60s
    kubectl logs -f -l job-name="$job" -n renovate

# Show latest Flatcar versions by channel
flatcar-versions:
    @echo "stable:"; curl -s https://stable.release.flatcar-linux.net/amd64-usr/current/version.txt | grep FLATCAR_VERSION
    @echo "beta:";   curl -s https://beta.release.flatcar-linux.net/amd64-usr/current/version.txt | grep FLATCAR_VERSION

# Resolve an image's digest and write/update its entry in lib/version-pins.json (e.g. `just define-image netbirdRouter netbirdio/netbird:0.67.4`)
define-image key imageTag:
    @bash scripts/define-image.sh {{ key }} {{ imageTag }}
