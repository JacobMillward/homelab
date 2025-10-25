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

# Creates a manual job from the CronJob, waits for the pod to become ready, then streams logs (falls back to describe if it times out)
renovate:
    #!/usr/bin/env bash
    set -euo pipefail
    JOB="manual-$(date +%s)"

    kubectl create job --from=cronjob/renovate-bot "$JOB" -n renovate

    if kubectl wait --for=condition=ready pod -l job-name="$JOB" -n renovate --timeout=180s; then
        POD=$(kubectl get pod -n renovate -l job-name="$JOB" -o jsonpath='{.items[0].metadata.name}')
        kubectl logs -f -n renovate "$POD" -c renovate-bot
    else
        echo "Pod did not become ready within timeout; showing pod list and describe:"
        kubectl get pods -n renovate -l job-name="$JOB" -o wide
        kubectl describe pods -n renovate -l job-name="$JOB"
        exit 1
    fi