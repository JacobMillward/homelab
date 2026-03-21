export PULUMI_BACKEND_URL := "file://" + justfile_directory() / ".pulumi"

talos_version := "v1.12.5"

[private]
default:
    @just --list

talosVersion:
    #!/usr/bin/env bash
    echo "Current Talos version: {{talos_version}}"
    latest_version=$(curl -s https://factory.talos.dev/versions | jq -r '[.[] | select(contains("-") | not)] | .[-1]')
    echo "Latest Talos version: $latest_version"

[doc("""
POST a node schematic to factory.talos.dev and print the schematic ID and ISO download URL
    Usage: just schematic nuc12i7
""")]
schematic NODE:
    #!/usr/bin/env bash
    set -euo pipefail
    SCHEMATIC_ID=$(curl -s -X POST \
        --data-binary @"talos/schematics/{{NODE}}.yaml" \
        https://factory.talos.dev/schematics | jq -r '.id')
    echo "Schematic ID: $SCHEMATIC_ID"
    echo "ISO: https://factory.talos.dev/image/$SCHEMATIC_ID/{{talos_version}}/metal-amd64.iso"
