#!/bin/sh
#
# Reads /config/sources.tsv and imports each pre-fetched /shared/<name>.txt
# into CrowdSec as local decisions, via cscli inside the running LAPI pod.
#
# Requires NAMESPACE and DECISION_DURATION in the environment. See
# fetch-lists.sh for the sources.tsv format.

set -eu

lapi_pod=$(kubectl get pods --namespace "$NAMESPACE" --selector type=lapi \
  --output jsonpath='{.items[0].metadata.name}')

import_source() {
  name=$1
  scope=$2

  kubectl exec --stdin --namespace "$NAMESPACE" "$lapi_pod" -- \
    cscli decisions import --input - \
    --format values \
    --scope "$scope" \
    --duration "$DECISION_DURATION" \
    --reason "blocklist/${name}" \
    < "/shared/${name}.txt"
}

while IFS="$(printf '\t')" read -r name _url scope _column; do
  [ -n "$name" ] || continue
  import_source "$name" "$scope"
done < /config/sources.tsv
