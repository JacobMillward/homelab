#!/bin/sh
#
# Fetches each blocklist source listed in /config/sources.tsv and writes
# a cleaned, one-entry-per-line copy to /shared/<name>.txt for
# import-lists.sh to consume.
#
# sources.tsv is tab-separated: name, url, scope, column
#   column is optional. When set, only that whitespace-separated field
#   of each line is kept (e.g. ipsum's "<ip><TAB><list-count>" format).

set -eu

fetch_source() {
  name=$1
  url=$2
  column=$3

  raw="/tmp/${name}.raw"
  clean="/shared/${name}.txt"

  curl --fail --silent --show-error --output "$raw" "$url"

  if [ -n "$column" ]; then
    grep -v '^#' "$raw" | grep -v '^$' | awk -v col="$column" '{ print $col }' > "$clean"
  else
    grep -v '^#' "$raw" | grep -v '^$' > "$clean"
  fi
}

while IFS="$(printf '\t')" read -r name url _scope column; do
  [ -n "$name" ] || continue
  fetch_source "$name" "$url" "$column"
done < /config/sources.tsv
