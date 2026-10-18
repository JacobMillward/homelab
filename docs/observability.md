# Observability

ClickStack (ClickHouse + HyperDX) in the cluster, OpenTelemetry collectors on the node and the VPS, ntfy for alerts.

## Pieces

| Piece | Where | Notes |
|-------|-------|-------|
| HyperDX | `https://hyperdx.internal.millward-yuan.net` | Mesh-only, behind Authelia. HyperDX has its own local accounts (no SSO for the UI), so the first visit creates a user. |
| ClickHouse, Keeper, MongoDB | namespace `observability` | ClickHouse and Keeper use the `longhorn-no-backup` class, so the NFS backups skip them. MongoDB (dashboards, alert rules) is backed up. |
| Gateway collector | `clickstack-otel-collector` | Part of the ClickStack chart. Creates the tables and checks the team API key. |
| Node collector | DaemonSet `otel-agent`, namespace `otel-agent` (the only privileged one; `observability` enforces `baseline`) | Container logs, kubelet and host metrics, cluster state, events, scraped service metrics, OTLP in from Traefik. |
| VPS collector | systemd `otel-collector` on the VPS | Host metrics, HAProxy logs and metrics, relay certificate expiry. Sends over WireGuard to the gateway (`10.99.0.2:4318`) with an on-disk queue. |
| ntfy | `https://ntfy.millward-yuan.net` | Own auth, deny-all by default, behind the CrowdSec Traefik plugin. Runs in the cluster. |

Retention: logs 30 days, metrics 90 days, traces 14 days (`HYPERDX_OTEL_EXPORTER_*_TTL` in `stacks/platform/observability/index.ts`).

## First-time setup (manual)

The collector only accepts a key that belongs to a HyperDX team, and the team exists after the first user registers. Until then the node and VPS collectors cannot deliver data.

1. Open HyperDX over the mesh and register your user.
2. Team Settings, copy the **API key**.
3. Set it on both stacks and apply:
   ```
   just pulumi platform config set --secret hyperdxIngestKey <key>
   just pulumi vps config set --secret otlpApiKey <key>
   just up platform
   just up vps      # recreates the VPS: short public outage; the IP is kept
   ```
   Run `pulumi up` in the background. A plain `just up platform` also applies any live drift, so preview first.
4. Check data arrives: HyperDX, Logs and Metrics sources.

## Alerts

HyperDX alert checks run as a CronJob (`hyperdx.tasks.enabled`). Create the webhook once, then the alerts:

1. Webhook (Team Settings, Integrations): URL `http://ntfy.ntfy.svc.cluster.local/alerts`, header `Authorization: Bearer <token>`. The token is the `hyperdx` token in the `ntfy` namespace: `kubectl -n ntfy get secret -o json | jq -r '.items[].data["server.yml"] // empty' | base64 -d | grep tk_`.
2. Alerts to create (a starting list; add one only when it should have paged you and did not):
   - Pod restarts or crash loops; OOMKilled.
   - Node disk, and the ClickHouse volume, over 85%.
   - Longhorn disk or a PVC over 85%; a degraded Longhorn volume.
   - Certificate expiring within 14 days (`certmanager_certificate_expiration_timestamp_seconds`); relay certificate (tlscheck).
   - PostgreSQL down.
   - Failed Renovate or CI job.
   - Stale WireGuard handshake (`wg_latest_handshake_age_seconds` over 300). This fires after recovery, not during an outage.

## Phone

- Android app, server `https://ntfy.millward-yuan.net`, user `phone`, password from `just pulumi platform stack output ntfyPhonePassword --show-secrets`. Subscribe to topic `alerts`.
- Turn on the connection-lost notification (Settings, Advanced). It is off by default and slow (about 15 minutes in older release notes). Time it once by stopping ntfy.

## Limits

- ntfy runs in the cluster, so it dies with the cluster. There is no active "homelab is down" page. The app's connection-lost notification is the only signal. Moving ntfy to the VPS later is possible.
- No linked HAProxy to Traefik traces (TCP passthrough). Correlate by client IP and time.
- Container logs on the VPS come from the Docker `json-file` driver (haproxy, relay). `journalctl` does not show those two; use `docker logs`.

- The collectors mount only `/proc` and `/sys`, not the host root, so a compromised collector cannot read node or VPS secrets. The cost: no filesystem-usage metrics from `hostmetrics`. Node disk comes from kubelet stats; the VPS has no disk-usage metric.

## Adding a scrape target

Add an entry to `SCRAPE_TARGETS` in `stacks/platform/observability/targets.ts` (namespace or empty for all, label selector, port, path; `bearerTokenEnvVar` for token-protected endpoints), then apply the platform stack.
