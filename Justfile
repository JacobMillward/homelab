export PULUMI_BACKEND_URL := "file://" + justfile_directory() / ".pulumi"

[private]
default:
    @just --list

# POST a node schematic to factory.talos.dev and print the schematic ID and ISO download URL
# Usage: just schematic nuc12i7
schematic NODE:
    #!/usr/bin/env bash
    set -euo pipefail
    SCHEMATIC_ID=$(curl -s -X POST \
        --data-binary @"talos/schematics/{{NODE}}.yaml" \
        https://factory.talos.dev/schematics | jq -r '.id')
    echo "Schematic ID: $SCHEMATIC_ID"
    echo "ISO: https://factory.talos.dev/image/$SCHEMATIC_ID/v1.12.5/metal-amd64.iso"
