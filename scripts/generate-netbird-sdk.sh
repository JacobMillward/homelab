#!/usr/bin/env bash
# Generates stacks/{apps,platform}/sdks/netbird from the packages.netbird spec
# in each stack's Pulumi.yaml, then refreshes pnpm's lockfile to match.
#
# Runs against a throwaway local Pulumi backend (see Pulumi.yaml's
# `backend: url: file://~`) so it never touches the real Garage backend or
# Pulumi Cloud. Fetches the pulumi CLI via @pulumi/pulumi's own Automation API
# (PulumiCommand.install), pinned to the same version as the SDK itself -
# no curl-piped installer, no copying binaries out of another image.
set -euo pipefail
cd "$(dirname "$0")/.."

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

(cd "$TMPDIR" && npm init -y >/dev/null && npm install @pulumi/pulumi --no-audit --no-fund --ignore-scripts >/dev/null)

node -e "
require('$TMPDIR/node_modules/@pulumi/pulumi/automation').PulumiCommand.install({ root: '$TMPDIR/.pulumi' })
  .catch(e => { console.error(e); process.exit(1); });
"

PULUMI="$TMPDIR/.pulumi/bin/pulumi"
"$PULUMI" install --no-dependencies --cwd stacks/apps
"$PULUMI" install --no-dependencies --cwd stacks/platform
rm -f stacks/apps/pnpm-workspace.yaml stacks/platform/pnpm-workspace.yaml

# Only the lockfile matters, and Renovate runs this holding a repo-write token.
pnpm install --ignore-scripts
