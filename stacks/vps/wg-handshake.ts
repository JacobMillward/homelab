export interface WgHandshakeArgs {
  textfileDir: string;
}

// Written for node_exporter's textfile collector. -1 means no handshake has completed yet.
export function buildWgHandshakeScript({ textfileDir }: WgHandshakeArgs): string {
  return `#!/bin/sh
set -eu
dir=${textfileDir}
last=$(wg show wg0 latest-handshakes | awk 'NR==1 {print $2}')
if [ -z "\${last:-}" ] || [ "$last" -eq 0 ]; then
  age=-1
else
  age=$(( $(date +%s) - last ))
fi
tmp=$(mktemp "$dir/.wg.XXXXXX")
printf '# TYPE wg_latest_handshake_age_seconds gauge\\nwg_latest_handshake_age_seconds %s\\n' "$age" > "$tmp"
chmod 0644 "$tmp"
mv "$tmp" "$dir/wg.prom"
`;
}
