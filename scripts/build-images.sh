#!/usr/bin/env bash
# Builds and pushes every images/* context whose content tag isn't in the
# registry yet. Run by .forgejo/workflows/images.yml, and by hand when you need
# an image before CI has it.
#
# buildah needs SYS_ADMIN, so in-cluster this only runs on the image-builder
# runner. Locally it just needs buildah on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${PUSH_HOST:?}" "${REGISTRY_USER:?}" "${REGISTRY_PASS:?}"

ACCEPT='application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json'

buildah login -u "$REGISTRY_USER" -p "$REGISTRY_PASS" "$PUSH_HOST"

for dir in images/*/; do
  name=$(basename "$dir")
  tag=$(node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/image-tag.ts "$dir")
  image="${PUSH_HOST}/${name}:${tag}"

  if curl -sfI -u "$REGISTRY_USER:$REGISTRY_PASS" -H "Accept: $ACCEPT" \
      "https://${PUSH_HOST}/v2/${name}/manifests/${tag}" >/dev/null; then
    echo "$name:$tag already pushed"
    continue
  fi

  echo "building $name:$tag"
  buildah bud --storage-driver vfs --isolation chroot -t "$image" "$dir"
  buildah push --storage-driver vfs "$image" "docker://$image"
done
