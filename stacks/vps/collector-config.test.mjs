import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVpsCollectorConfig } from "./collector-config.ts";

const args = {
  gatewayEndpoint: "http://10.99.0.2:4318",
  apiKeyEnvVar: "HYPERDX_API_KEY",
  relayTlsEndpoint: "127.0.0.1:33443",
  haproxyMetricsEndpoint: "127.0.0.1:8404",
  nodeExporterEndpoint: "127.0.0.1:9100",
};
const cfg = () => JSON.parse(buildVpsCollectorConfig(args));

test("memory_limiter is the first processor of every pipeline", () => {
  for (const [name, p] of Object.entries(cfg().service.pipelines)) {
    assert.equal(p.processors[0], "memory_limiter", `pipeline ${name}`);
  }
});

test("a persistent on-disk queue keeps data through a tunnel outage", () => {
  const c = cfg();
  const ex = c.exporters.otlphttp;
  assert.equal(ex.sending_queue.enabled, true);
  assert.equal(ex.sending_queue.storage, "file_storage/queue");
  assert.ok(c.extensions["file_storage/queue"].directory.startsWith("/var/lib/otelcol"));
  assert.ok(c.service.extensions.includes("file_storage/queue"));
  assert.equal(ex.retry_on_failure.max_elapsed_time, 0, "never give up on a queued batch");
});

test("sends OTLP/HTTP to the gateway with the API key read from the environment", () => {
  const ex = cfg().exporters.otlphttp;
  assert.equal(ex.endpoint, "http://10.99.0.2:4318");
  assert.equal(ex.headers.authorization, "${env:HYPERDX_API_KEY}");
});

test("scrapes HAProxy and node_exporter and checks the relay certificate", () => {
  const c = cfg();
  const jobs = c.receivers.prometheus.config.scrape_configs;
  const haproxy = jobs.find((j) => j.job_name === "haproxy");
  assert.deepEqual(haproxy.static_configs[0].targets, ["127.0.0.1:8404"]);
  assert.deepEqual(jobs.find((j) => j.job_name === "node-exporter").static_configs[0].targets, ["127.0.0.1:9100"]);
  assert.deepEqual(c.receivers.tlscheck.targets, [{ endpoint: "127.0.0.1:33443" }]);
  assert.ok(c.service.pipelines.metrics.receivers.includes("tlscheck"));
});

test("reads Docker json-file container logs and host metrics from the mounted root", () => {
  const c = cfg();
  assert.deepEqual(c.receivers.filelog.include, ["/var/lib/docker/containers/*/*-json.log"]);
  assert.equal(c.receivers.hostmetrics.root_path, "/hostfs");
  assert.ok(c.service.pipelines.logs.receivers.includes("filelog"));
});

test("host metrics skip the filesystem scraper, which would need the host root mounted", () => {
  const scrapers = Object.keys(cfg().receivers.hostmetrics.scrapers);
  assert.ok(!scrapers.includes("filesystem"));
  assert.ok(scrapers.includes("cpu") && scrapers.includes("memory") && scrapers.includes("network"));
});
