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

# Force a reconciliation of the flux-system Git source
sync:
    #!/usr/bin/env bash
    flux reconcile source git flux-system

    # Get known reconcilations by counting lines that do not start with "NAME" and are not empty
    RECONCILIATIONS=$(flux get all | grep -v '^NAME' | grep -v '^$' | wc -l)

    # Set a timeout of 5 minutes
    TIMEOUT=300

    # In a loop, wait for all reconcilations to complete. Make a progress bar with a count of X/Y
    echo -n "Waiting for $RECONCILIATIONS reconcilations to complete"
    START_TIME=$(date +%s)
    while true; do
        CURRENT_TIME=$(date +%s)
        ELAPSED_TIME=$((CURRENT_TIME - START_TIME))
        if [ "$ELAPSED_TIME" -ge "$TIMEOUT" ]; then
            echo -e "\nTimeout reached while waiting for reconcilations to complete."
            exit 1
        fi

        REMAINING=$(flux get all --status-selector ready=false | grep -v '^NAME' | grep -v '^$' | wc -l)
        if [ "$REMAINING" -eq 0 ]; then
            break
        fi
        echo -ne "\rWaiting for $REMAINING/$RECONCILIATIONS reconcilations to complete"
        sleep 5
    done
    echo -e "\nAll reconcilations completed."
