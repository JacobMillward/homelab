export interface VpsCollectorArgs {
  gatewayEndpoint: string;
  apiKeyEnvVar: string;
  relayTlsEndpoint: string;
  haproxyMetricsEndpoint: string;
  nodeExporterEndpoint: string;
}

const QUEUE = "file_storage/queue";

// JSON is valid YAML, so the collector reads this output as-is.
export function buildVpsCollectorConfig(args: VpsCollectorArgs): string {
  const processors = ["memory_limiter", "resourcedetection", "batch"];
  const scrape = (job: string, target: string) => ({
    job_name: job,
    scrape_interval: "30s",
    metrics_path: "/metrics",
    static_configs: [{ targets: [target] }],
  });

  return JSON.stringify(
    {
      extensions: { [QUEUE]: { directory: "/var/lib/otelcol/queue", create_directory: true } },
      receivers: {
        filelog: {
          // Only containers on the json-file log driver show up here (haproxy, relay).
          include: ["/var/lib/docker/containers/*/*-json.log"],
          start_at: "end",
          operators: [{ type: "container", id: "container-parser" }],
        },
        host_metrics: {
          collection_interval: "30s",
          root_path: "/hostfs",
          scrapers: { cpu: {}, load: {}, memory: {}, disk: {}, network: {} },
        },
        prometheus: {
          config: {
            scrape_configs: [
              scrape("haproxy", args.haproxyMetricsEndpoint),
              scrape("node-exporter", args.nodeExporterEndpoint),
            ],
          },
        },
        tlscheck: { collection_interval: "1h", targets: [{ endpoint: args.relayTlsEndpoint }] },
      },
      processors: {
        memory_limiter: { check_interval: "5s", limit_percentage: 80, spike_limit_percentage: 25 },
        resourcedetection: { detectors: ["system"], system: { hostname_sources: ["os"] } },
        batch: {},
      },
      exporters: {
        otlphttp: {
          endpoint: args.gatewayEndpoint,
          compression: "gzip",
          headers: { authorization: `\${env:${args.apiKeyEnvVar}}` },
          sending_queue: { enabled: true, storage: QUEUE, queue_size: 5000 },
          retry_on_failure: { enabled: true, max_elapsed_time: 0 },
        },
      },
      service: {
        extensions: [QUEUE],
        pipelines: {
          logs: { receivers: ["filelog"], processors, exporters: ["otlphttp"] },
          metrics: { receivers: ["host_metrics", "prometheus", "tlscheck"], processors, exporters: ["otlphttp"] },
        },
      },
    },
    null,
    2,
  );
}
