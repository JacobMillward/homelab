import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentCollectorConfig } from "./agent-config.ts";

const args = {
  gatewayEndpoint: "http://gw.example:4318",
  apiKeyEnvVar: "HYPERDX_API_KEY",
  scrapeTargets: [
    { job: "longhorn", namespace: "longhorn-system", labelSelector: "app=longhorn-manager", port: 9500, path: "/metrics" },
    { job: "certmanager", namespace: "cert-manager", labelSelector: "app.kubernetes.io/name=cert-manager", port: 9402, path: "/metrics" },
  ],
  scrapeIntervalSeconds: 30,
  excludeLogNamespaces: ["observability"],
};
const cfg = () => JSON.parse(buildAgentCollectorConfig(args));

test("memory_limiter is the first processor of every pipeline", () => {
  const pipelines = cfg().service.pipelines;
  assert.ok(Object.keys(pipelines).length >= 3);
  for (const [name, p] of Object.entries(pipelines)) {
    assert.equal(p.processors[0], "memory_limiter", `pipeline ${name}`);
  }
});

test("collects node, pod, cluster, event and log signals", () => {
  const receivers = Object.keys(cfg().receivers);
  for (const r of ["filelog", "kubelet_stats", "host_metrics", "k8s_cluster", "k8s_objects", "prometheus", "otlp"]) {
    assert.ok(receivers.includes(r), `receiver ${r}`);
  }
});

test("filelog excludes each configured namespace", () => {
  const exclude = cfg().receivers.filelog.exclude;
  assert.ok(exclude.some((e) => e.includes("/var/log/pods/observability_")));
});

test("every scrape target becomes a job with the configured interval and port", () => {
  const jobs = cfg().receivers.prometheus.config.scrape_configs;
  for (const t of args.scrapeTargets) {
    const job = jobs.find((j) => j.job_name === t.job);
    assert.ok(job, `job ${t.job}`);
    assert.equal(job.scrape_interval, "30s");
    assert.equal(job.metrics_path, t.path);
    assert.ok(JSON.stringify(job).includes(`:${t.port}`));
  }
});

test("exports OTLP/HTTP to the gateway with the API key from the environment", () => {
  const ex = cfg().exporters.otlphttp;
  assert.equal(ex.endpoint, "http://gw.example:4318");
  assert.equal(ex.headers.authorization, "${env:HYPERDX_API_KEY}");
});

test("prometheus and kubelet_stats feed metrics only, never logs", () => {
  const { logs, metrics } = cfg().service.pipelines;
  assert.ok(!logs.receivers.includes("prometheus"));
  assert.ok(!logs.receivers.includes("kubelet_stats"));
  assert.ok(metrics.receivers.includes("prometheus"));
});

test("omits the prometheus receiver when there are no scrape targets", () => {
  const c = JSON.parse(buildAgentCollectorConfig({ ...args, scrapeTargets: [] }));
  assert.ok(!("prometheus" in c.receivers));
  assert.ok(!c.service.pipelines.metrics.receivers.includes("prometheus"));
});

test("an empty namespace scrapes matching pods in every namespace", () => {
  const c = JSON.parse(buildAgentCollectorConfig({
    ...args,
    scrapeTargets: [{ job: "pg", namespace: "", labelSelector: "cnpg.io/podRole=instance", port: 9187, path: "/metrics" }],
  }));
  const sd = c.receivers.prometheus.config.scrape_configs[0].kubernetes_sd_configs[0];
  assert.ok(!("namespaces" in sd));
});

test("a scrape target can authenticate with a bearer token from the environment", () => {
  const c = JSON.parse(buildAgentCollectorConfig({
    ...args,
    scrapeTargets: [{ job: "forgejo", namespace: "forgejo", labelSelector: "app=forgejo", port: 3000, path: "/metrics", bearerTokenEnvVar: "FORGEJO_METRICS_TOKEN" }],
  }));
  assert.equal(c.receivers.prometheus.config.scrape_configs[0].authorization.credentials, "${env:FORGEJO_METRICS_TOKEN}");
});

test("host metrics skip the filesystem scraper, which would need the host root mounted", () => {
  const scrapers = Object.keys(cfg().receivers.host_metrics.scrapers);
  assert.ok(!scrapers.includes("filesystem"));
  assert.ok(scrapers.includes("cpu") && scrapers.includes("memory") && scrapers.includes("network"));
});

test("kubelet_stats collects volume usage for PVC alerts", () => {
  const groups = cfg().receivers.kubelet_stats.metric_groups;
  for (const g of ["node", "pod", "container", "volume"]) assert.ok(groups.includes(g), g);
});

test("kubelet_stats resolves PVC names through the Kubernetes API", () => {
  const r = cfg().receivers.kubelet_stats;
  assert.deepEqual(r.k8s_api_config, { auth_type: "serviceAccount" });
  assert.ok(r.extra_metadata_labels.includes("k8s.volume.type"));
});
