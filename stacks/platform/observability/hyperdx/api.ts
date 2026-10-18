export interface AlertDef {
  name: string;
  sql: string;
  threshold: number;
  thresholdType: "above" | "below";
  interval: "1m" | "5m" | "15m" | "30m" | "1h" | "6h" | "12h" | "1d";
}

const gauge = "default.otel_metrics_gauge";
const DAY = 86400;

export const ALERTS: AlertDef[] = [
  {
    name: "Pod restarts",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts, sum(d) AS restarts
FROM (
  SELECT TimeUnix, max(Value) OVER w - min(Value) OVER w AS d
  FROM ${gauge}
  WHERE MetricName = 'k8s.container.restarts' AND $__timeFilter(TimeUnix)
  WINDOW w AS (PARTITION BY ResourceAttributes['k8s.pod.name'], ResourceAttributes['k8s.container.name'])
)
GROUP BY ts`,
    threshold: 0,
    thresholdType: "above",
    interval: "5m",
  },
  {
    name: "Node disk over 85%",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts,
  maxIf(Value, MetricName = 'k8s.node.filesystem.usage') / maxIf(Value, MetricName = 'k8s.node.filesystem.capacity') * 100 AS pct
FROM ${gauge}
WHERE MetricName IN ('k8s.node.filesystem.usage', 'k8s.node.filesystem.capacity') AND $__timeFilter(TimeUnix)
GROUP BY ts`,
    threshold: 85,
    thresholdType: "above",
    interval: "15m",
  },
  {
    name: "Volume over 85%",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts,
  max(100 - avail / cap * 100) AS pct
FROM (
  SELECT TimeUnix, ResourceAttributes['k8s.persistentvolumeclaim.name'] AS pvc,
    maxIf(Value, MetricName = 'k8s.volume.available') AS avail,
    maxIf(Value, MetricName = 'k8s.volume.capacity') AS cap
  FROM ${gauge}
  WHERE MetricName IN ('k8s.volume.available', 'k8s.volume.capacity') AND $__timeFilter(TimeUnix)
  GROUP BY TimeUnix, pvc
  HAVING cap > 0 AND pvc != ''
)
GROUP BY ts`,
    threshold: 85,
    thresholdType: "above",
    interval: "15m",
  },
  {
    name: "Longhorn disk over 85%",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts,
  maxIf(Value, MetricName = 'longhorn_disk_usage_bytes') / maxIf(Value, MetricName = 'longhorn_disk_capacity_bytes') * 100 AS pct
FROM ${gauge}
WHERE MetricName IN ('longhorn_disk_usage_bytes', 'longhorn_disk_capacity_bytes') AND $__timeFilter(TimeUnix)
GROUP BY ts`,
    threshold: 85,
    thresholdType: "above",
    interval: "15m",
  },
  {
    // longhorn_volume_robustness: 1 healthy, 2 degraded, 3 faulted.
    name: "Longhorn volume degraded",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts, max(Value) AS robustness
FROM ${gauge}
WHERE MetricName = 'longhorn_volume_robustness' AND $__timeFilter(TimeUnix)
GROUP BY ts`,
    threshold: 1,
    thresholdType: "above",
    interval: "15m",
  },
  {
    name: "Certificate expires within 14 days",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts, min(Value) - toUnixTimestamp(now()) AS seconds_left
FROM ${gauge}
WHERE MetricName = 'certmanager_certificate_expiration_timestamp_seconds' AND $__timeFilter(TimeUnix)
GROUP BY ts`,
    threshold: 14 * DAY,
    thresholdType: "below",
    interval: "1h",
  },
  {
    name: "Relay certificate expires within 14 days",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts, min(Value) AS seconds_left
FROM ${gauge}
WHERE MetricName = 'tlscheck.time_left' AND $__timeFilter(TimeUnix)
GROUP BY ts`,
    threshold: 14 * DAY,
    thresholdType: "below",
    interval: "1h",
  },
  {
    name: "PostgreSQL down",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts, min(Value) AS up
FROM ${gauge}
WHERE MetricName = 'cnpg_collector_up' AND $__timeFilter(TimeUnix)
GROUP BY ts`,
    threshold: 1,
    thresholdType: "below",
    interval: "5m",
  },
  {
    // Healthy is under 3 minutes with a 25 second keepalive.
    name: "WireGuard handshake stale",
    sql: `SELECT $__timeInterval(TimeUnix) AS ts, max(Value) AS age_seconds
FROM ${gauge}
WHERE MetricName = 'wg_latest_handshake_age_seconds' AND $__timeFilter(TimeUnix)
GROUP BY ts`,
    threshold: 180,
    thresholdType: "above",
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
    name: def.name,
    threshold: def.threshold,
    thresholdType: def.thresholdType,
    interval: def.interval,
    channels: [{ type: "webhook", webhookId: ctx.webhookId }],
    chartConfig: {
      displayType: "line",
      configType: "sql",
      connectionId: ctx.connectionId,
      ...(ctx.sourceId ? { sourceId: ctx.sourceId } : {}),
      sqlTemplate: def.sql,
      name: def.name,
    },
  };
}

export interface WebhookArgs {
  name: string;
  url: string;
  token: string;
}

export function buildWebhookBody(args: WebhookArgs) {
  return {
    name: args.name,
    service: "generic",
    url: args.url,
    description: "ntfy topic for homelab alerts",
    headers: { Authorization: `Bearer ${args.token}` },
    body: "{{title}}\n{{body}}\n{{link}}",
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
