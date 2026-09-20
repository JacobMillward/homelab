#!/usr/bin/env bash
# Resolve an image's digest and write/update its entry in lib/version-pins.json.
# Usage: define-image.sh <key> <image>:<tag>
set -euo pipefail

KEY="$1"
IMAGE_TAG="$2"
TAG="${IMAGE_TAG##*:}"
IMAGE="${IMAGE_TAG%:*}"

case "$IMAGE" in
  */*/*) REGISTRY="${IMAGE%%/*}"; REPO="${IMAGE#*/}" ;;
  */*)
    FIRST="${IMAGE%%/*}"
    if [[ "$FIRST" == *.* || "$FIRST" == *:* || "$FIRST" == "localhost" ]]; then
      REGISTRY="$FIRST"; REPO="${IMAGE#*/}"
    else
      REGISTRY="registry-1.docker.io"; REPO="$IMAGE"
    fi
    ;;
  *) REGISTRY="registry-1.docker.io"; REPO="library/$IMAGE" ;;
esac

ACCEPT=(
  -H "Accept: application/vnd.docker.distribution.manifest.v2+json"
  -H "Accept: application/vnd.oci.image.manifest.v1+json"
  -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json"
  -H "Accept: application/vnd.oci.image.index.v1+json"
)
MANIFEST_URL="https://$REGISTRY/v2/$REPO/manifests/$TAG"

AUTH_HEADER=$(curl -sI "${ACCEPT[@]}" "$MANIFEST_URL" | grep -i "^www-authenticate:" | tr -d '\r' || true)
AUTH_ARG=()
if [ -n "$AUTH_HEADER" ]; then
  REALM=$(sed -n 's/.*realm="\([^"]*\)".*/\1/p' <<< "$AUTH_HEADER")
  SERVICE=$(sed -n 's/.*service="\([^"]*\)".*/\1/p' <<< "$AUTH_HEADER")
  TOKEN=$(curl -s "$REALM?service=$SERVICE&scope=repository:$REPO:pull" | jq -r '.token')
  AUTH_ARG=(-H "Authorization: Bearer $TOKEN")
fi

DIGEST=$(curl -s -I "${ACCEPT[@]}" "${AUTH_ARG[@]}" "$MANIFEST_URL" | grep -i "^docker-content-digest:" | tr -d '\r' | awk '{print $2}')
if [ -z "$DIGEST" ]; then
  echo "Could not resolve digest for $IMAGE:$TAG" >&2
  exit 1
fi

PINS_FILE="lib/version-pins.json"
UPDATED=$(jq --arg key "$KEY" --arg image "$IMAGE" --arg tag "$TAG" --arg digest "$DIGEST" \
  '.docker[$key] = {image: $image, tag: $tag, digest: $digest}' "$PINS_FILE")

CATEGORIES=$(jq -r 'keys_unsorted[]' <<< "$UPDATED")

{
  echo "{"
  LAST=$(echo "$CATEGORIES" | tail -1)
  while IFS= read -r category; do
    COMMA=","
    [ "$category" = "$LAST" ] && COMMA=""

    if [ "$category" = "docker" ]; then
      echo "  \"docker\": {"
      ENTRY_KEYS=$(jq -r '.docker | keys_unsorted[]' <<< "$UPDATED")
      LAST_ENTRY=$(echo "$ENTRY_KEYS" | tail -1)
      while IFS= read -r entry_key; do
        ENTRY_COMMA=","
        [ "$entry_key" = "$LAST_ENTRY" ] && ENTRY_COMMA=""
        LINE=$(jq -c --arg k "$entry_key" '.docker[$k]' <<< "$UPDATED" \
          | sed -E 's/^\{/{ /; s/\}$/ }/; s/":"/": "/g; s/","/", "/g')
        echo "    \"$entry_key\": $LINE$ENTRY_COMMA"
      done <<< "$ENTRY_KEYS"
      echo "  }$COMMA"
    else
      jq --indent 2 --arg c "$category" '{($c): .[$c]}' <<< "$UPDATED" \
        | sed '1d;$d' \
        | sed "\$s/\$/$COMMA/"
    fi
  done <<< "$CATEGORIES"
  echo "}"
} > "$PINS_FILE"

echo "docker.$KEY = $(jq -c --arg key "$KEY" '.docker[$key]' <<< "$UPDATED")"
