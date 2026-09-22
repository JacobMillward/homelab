#!/usr/bin/env bash
# Builds and pushes every images/* context whose content tag isn't in the
# registry yet. Run by `just images` and by .forgejo/workflows/images.yml.
#
# The registry allows anonymous reads, so the up-to-date check costs one HEAD
# per image and no credentials. Those are only resolved if something needs
# building, which keeps this cheap enough to run before every apply.
#
# buildah needs SYS_ADMIN, so in-cluster this only runs on the image-builder
# runner. Locally it just needs buildah on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${PUSH_HOST:?}"

ACCEPT='application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'

manifest_exists() {
  curl -sfI -o /dev/null -H "Accept: $ACCEPT" \
    "https://${PUSH_HOST}/v2/$1/manifests/$2"
}

stale=()
for dir in images/*/; do
  name=$(basename "$dir")
  tag=$(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/image-tag.ts "$dir")
  if manifest_exists "$name" "$tag"; then
    echo "$name:$tag up to date"
  else
    stale+=("$name:$tag:$dir")
  fi
done

[ ${#stale[@]} -eq 0 ] && exit 0

# REGISTRY_PASS_CMD lets the caller defer an expensive lookup (a Pulumi stack
# output, say) until a build is actually needed.
if [ -z "${REGISTRY_PASS:-}" ] && [ -n "${REGISTRY_PASS_CMD:-}" ]; then
  REGISTRY_PASS=$(eval "$REGISTRY_PASS_CMD")
fi
: "${REGISTRY_USER:?}" "${REGISTRY_PASS:?}"

buildah login -u "$REGISTRY_USER" -p "$REGISTRY_PASS" "$PUSH_HOST"

for entry in "${stale[@]}"; do
  IFS=: read -r name tag dir <<<"$entry"
  image="${PUSH_HOST}/${name}:${tag}"
  echo "building $name:$tag"
  buildah bud --storage-driver vfs --isolation chroot -t "$image" "$dir"
  buildah push --storage-driver vfs "$image" "docker://$image"
done
