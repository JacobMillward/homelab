# Runbook recipes for uncommon operational fixes
# Usage: just --justfile runbook.justfile <recipe>

[private]
default:
    @just --justfile runbook.justfile --list

# Restore NetBird tunnel after VPS recreation / IP change
netbird-bounce-vps:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "==> Restarting wg-home-peer..."
    kubectl rollout restart deployment/wg-home-peer -n netbird
    kubectl rollout status deployment/wg-home-peer -n netbird
    echo "==> Restarting netbird-router..."
    kubectl rollout restart deployment/netbird-router -n netbird
    kubectl rollout status deployment/netbird-router -n netbird
