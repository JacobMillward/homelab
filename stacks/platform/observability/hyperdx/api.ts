export interface AlertDef {
  id: string;
  title: string;
  note: string;
  sql: string;
  threshold: number;
  interval: "1m" | "5m" | "15m" | "30m" | "1h" | "6h" | "12h" | "1d";
}

const gauge = "default.otel_metrics_gauge";
const DAY = 86400;

// Every query is 0 when healthy: HyperDX reads an empty window as 0, and an alert fires at >= threshold.
// A second string column names the culprit; HyperDX alerts and clears each name on its own.
export const ALERTS: AlertDef[] = [
  {
    id: "pod-restarts",
    title: "Restarting: {{group}} ({{value}} times in 5 minutes)",
    note: "This container crashed or ran out of memory. Open Logs in HyperDX and search for its name to see why. If it began right after an update, revert that update in Git.",
    sql: `SELECT ts, pod, sum(d) AS restarts
FROM (
  SELECT $__timeInterval(TimeUnix) AS ts,
    concat(ResourceAttributes['k8s.namespace.name'], '/', ResourceAttributes['k8s.pod.name']) AS pod,
    max(Value) - min(Value) AS d
  FROM ${gauge}
  WHERE MetricName = 'k8s.container.restarts' AND $__timeFilter(TimeUnix)
  GROUP BY ts, pod, ResourceAttributes['k8s.container.name']
)
GROUP BY ts, pod`,
    threshold: 1,
    interval: "5m",
  },
  {
    id: "node-disk",
    title: "The server disk is {{value}}% full",
    note: "At 100% the server evicts pods and services stop. Container images and logs are the usual cause. In HyperDX, the metric k8s.node.filesystem.usage shows what the trend looks like.",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts,
  round(maxIf(Value, MetricName = 'k8s.node.filesystem.usage') / maxIf(Value, MetricName = 'k8s.node.filesystem.capacity') * 100) AS pct
FROM ${gauge}
WHERE MetricName IN ('k8s.node.filesystem.usage', 'k8s.node.filesystem.capacity') AND $__timeFilter(TimeUnix)
GROUP BY ts`,
    threshold: 85,
    interval: "15m",
  },
  {
    id: "volume-full",
    title: "Volume nearly full: {{group}} ({{value}}%)",
    note: "An app has nearly filled its storage. Free up data inside that app, or raise the volume size in the homelab code and apply it.",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts, pvc AS volume, round(max(100 - avail / cap * 100)) AS pct
FROM (
  SELECT TimeUnix, ResourceAttributes['k8s.persistentvolumeclaim.name'] AS pvc,
    maxIf(Value, MetricName = 'k8s.volume.available') AS avail,
    maxIf(Value, MetricName = 'k8s.volume.capacity') AS cap
  FROM ${gauge}
  WHERE MetricName IN ('k8s.volume.available', 'k8s.volume.capacity') AND $__timeFilter(TimeUnix)
  GROUP BY TimeUnix, pvc
  HAVING cap > 0 AND pvc != ''
)
GROUP BY ts, pvc`,
    threshold: 85,
    interval: "15m",
  },
  {
    id: "longhorn-disk",
    title: "The storage disk is {{value}}% full",
    note: "This disk holds every app's volumes. When it fills, apps can no longer save data. Delete data in the biggest apps, or add disk.",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts,
  round(maxIf(Value, MetricName = 'longhorn_disk_usage_bytes') / maxIf(Value, MetricName = 'longhorn_disk_capacity_bytes') * 100) AS pct
FROM ${gauge}
WHERE MetricName IN ('longhorn_disk_usage_bytes', 'longhorn_disk_capacity_bytes') AND $__timeFilter(TimeUnix)
GROUP BY ts`,
    threshold: 85,
    interval: "15m",
  },
  {
    // longhorn_volume_robustness: 1 healthy, 2 degraded, 3 faulted.
    id: "longhorn-volume",
    title: "Storage volume unhealthy: {{group}}",
    note: "Longhorn says a copy of this volume's data is missing or broken. Open Logs in HyperDX and search for the namespace longhorn-system to see why.",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts, concat(Attributes['pvc_namespace'], '/', Attributes['pvc']) AS volume, max(Value) AS robustness
FROM ${gauge}
WHERE MetricName = 'longhorn_volume_robustness' AND $__timeFilter(TimeUnix)
GROUP BY ts, volume`,
    threshold: 2,
    interval: "15m",
  },
  {
    id: "certificate-expiry",
    title: "Certificate expiring within 14 days: {{group}}",
    note: "Automatic renewal is failing, so sites using it will break when it expires. Open Logs in HyperDX and search for cert-manager; the error says why.",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts, Attributes['name'] AS certificate,
  greatest(0, ${14 * DAY} - (min(Value) - toUnixTimestamp(now()))) AS seconds_short
FROM ${gauge}
WHERE MetricName = 'certmanager_certificate_expiration_timestamp_seconds' AND $__timeFilter(TimeUnix)
GROUP BY ts, certificate`,
    threshold: 1,
    interval: "1h",
  },
  {
    id: "relay-certificate-expiry",
    title: "The NetBird relay certificate expires within 14 days",
    note: "Its daily renewal on the VPS is failing, and the VPS cannot be logged into. Check the Cloudflare token it renews with is still valid, then apply the VPS stack. Rebuilding the VPS issues a new certificate, with a few minutes of outage.",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts, greatest(0, ${14 * DAY} - min(Value)) AS seconds_short
FROM ${gauge}
WHERE MetricName = 'tlscheck.time_left' AND $__timeFilter(TimeUnix)
GROUP BY ts`,
    threshold: 1,
    interval: "1h",
  },
  {
    id: "database-down",
    title: "Database down: {{group}}",
    note: "Apps that use it will fail. Open Logs in HyperDX and search for the database name to see why. If a storage alert fired recently, a full disk is the likely cause.",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts, Attributes['cluster'] AS database, 1 - min(Value) AS down
FROM ${gauge}
WHERE MetricName = 'cnpg_collector_up' AND $__timeFilter(TimeUnix)
GROUP BY ts, database`,
    threshold: 1,
    interval: "5m",
  },
  {
    // Healthy is under 3 minutes with a 25 second keepalive.
    id: "vpn-tunnel",
    title: "The VPS tunnel has been silent for {{value}} seconds",
    note: "Home and the VPS cannot talk, so public sites and pushing code are unreachable. First check the home internet is up. If it is, check the VPS is running in the Hetzner console.",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts, round(max(Value)) AS age_seconds
FROM ${gauge}
WHERE MetricName = 'wg_latest_handshake_age_seconds' AND $__timeFilter(TimeUnix)
GROUP BY ts`,
    threshold: 180,
    interval: "5m",
  },
];

export interface AlertContext {
  connectionId: string;
  sourceId?: string;
  webhookId: string;
}

export function buildAlertBody(def: AlertDef, ctx: AlertContext) {
  return {
    source: "inline",
    name: def.title,
    note: def.note,
    threshold: def.threshold,
    thresholdType: "above",
    interval: def.interval,
    channels: [{ type: "webhook", webhookId: ctx.webhookId }],
    chartConfig: {
      displayType: "line",
      configType: "sql",
      connectionId: ctx.connectionId,
      ...(ctx.sourceId ? { sourceId: ctx.sourceId } : {}),
      sqlTemplate: def.sql,
      name: def.id,
    },
  };
}

export interface WebhookArgs {
  name: string;
  url: string;
  token: string;
  topic: string;
}

export function buildWebhookBody(args: WebhookArgs) {
  const message = '{{#if (eq status "firing")}}{{note}}{{else}}This has cleared.{{/if}}';
  const priority = '{{#if (eq status "firing")}}4{{else}}2{{/if}}';
  return {
    name: args.name,
    service: "generic",
    url: args.url,
    description: "Publishes to the ntfy alerts topic",
    headers: { Authorization: `Bearer ${args.token}`, "Content-Type": "application/json" },
    body: `{"topic":"${args.topic}","title":"{{title}}","message":"${message}","priority":${priority},"click":"{{hdxLink}}"}`,
  };
}

export interface ResolvedClient {
  endpoint: string;
  apiKey: string;
}

export async function hyperdxRequest<T = unknown>(
  client: ResolvedClient,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await fetchImpl(`${client.endpoint.replace(/\/$/, "")}/api/v2${path}`, {
    method,
    headers: { Authorization: `Bearer ${client.apiKey}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HyperDX API ${method} ${path} failed: ${res.status} ${text}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  const parsed = JSON.parse(text);
  return (parsed.data ?? parsed) as T;
}

const idOf = (r: { id?: string; _id?: string }) => String(r.id ?? r._id);

export interface WebhookInputs {
  client: ResolvedClient;
  name: string;
  url: string;
  token: string;
  topic: string;
}

export interface WebhookOutputs extends WebhookInputs {
  webhookId: string;
}

export const webhookProvider = {
  async create(inputs: WebhookInputs, fetchImpl: typeof fetch = fetch): Promise<{ id: string; outs: WebhookOutputs }> {
    const hook = await hyperdxRequest<{ id?: string; _id?: string }>(
      inputs.client, "POST", "/webhooks", buildWebhookBody(inputs), fetchImpl);
    const webhookId = idOf(hook);
    return { id: webhookId, outs: { ...inputs, webhookId } };
  },
  async update(id: string, olds: WebhookOutputs, news: WebhookInputs, fetchImpl: typeof fetch = fetch) {
    await hyperdxRequest(news.client, "PUT", `/webhooks/${olds.webhookId}`, buildWebhookBody(news), fetchImpl);
    return { outs: { ...news, webhookId: olds.webhookId } };
  },
  async delete(id: string, outs: { client: ResolvedClient; webhookId: string }, fetchImpl: typeof fetch = fetch) {
    await hyperdxRequest(outs.client, "DELETE", `/webhooks/${outs.webhookId}`, undefined, fetchImpl);
  },
};

export interface AlertInputs {
  client: ResolvedClient;
  def: AlertDef;
  webhookId: string;
}

export interface AlertOutputs extends AlertInputs {
  alertId: string;
}

async function alertBody(inputs: AlertInputs, fetchImpl: typeof fetch) {
  const connections = await hyperdxRequest<{ id?: string; _id?: string }[]>(inputs.client, "GET", "/connections", undefined, fetchImpl);
  if (!connections?.length) throw new Error("HyperDX has no ClickHouse connection to run alert queries against");
  return buildAlertBody(inputs.def, { connectionId: idOf(connections[0]), webhookId: inputs.webhookId });
}

export const alertProvider = {
  async create(inputs: AlertInputs, fetchImpl: typeof fetch = fetch): Promise<{ id: string; outs: AlertOutputs }> {
    const alert = await hyperdxRequest<{ id?: string; _id?: string }>(
      inputs.client, "POST", "/alerts", await alertBody(inputs, fetchImpl), fetchImpl);
    const alertId = idOf(alert);
    return { id: alertId, outs: { ...inputs, alertId } };
  },
  async update(id: string, olds: AlertOutputs, news: AlertInputs, fetchImpl: typeof fetch = fetch) {
    await hyperdxRequest(news.client, "PUT", `/alerts/${olds.alertId}`, await alertBody(news, fetchImpl), fetchImpl);
    return { outs: { ...news, alertId: olds.alertId } };
  },
  async delete(id: string, outs: { client: ResolvedClient; alertId: string }, fetchImpl: typeof fetch = fetch) {
    await hyperdxRequest(outs.client, "DELETE", `/alerts/${outs.alertId}`, undefined, fetchImpl);
  },
};
