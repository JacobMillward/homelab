export interface ScrapeTarget {
  job: string;
  // Empty means every namespace.
  namespace: string;
  labelSelector: string;
  port: number;
  path: string;
  bearerTokenEnvVar?: string;
}

export interface AgentConfigArgs {
  gatewayEndpoint: string;
  apiKeyEnvVar: string;
  scrapeTargets: ScrapeTarget[];
  scrapeIntervalSeconds: number;
  excludeLogNamespaces: string[];
}

// JSON is valid YAML, so the collector reads this output as-is.
export function buildAgentCollectorConfig(args: AgentConfigArgs): string {
  const interval = `${args.scrapeIntervalSeconds}s`;

  const scrapeConfigs = args.scrapeTargets.map((t) => ({
    job_name: t.job,
    scrape_interval: interval,
    metrics_path: t.path,
    ...(t.bearerTokenEnvVar ? { authorization: { type: "Bearer", credentials: `\${env:${t.bearerTokenEnvVar}}` } } : {}),
    kubernetes_sd_configs: [
      {
        role: "pod",
        ...(t.namespace ? { namespaces: { names: [t.namespace] } } : {}),
        selectors: [{ role: "pod", label: t.labelSelector }],
      },
    ],
    relabel_configs: [
      {
        source_labels: ["__meta_kubernetes_pod_ip"],
        target_label: "__address__",
        replacement: `$$1:${t.port}`,
      },
      { source_labels: ["__meta_kubernetes_pod_name"], target_label: "pod" },
    ],
  }));

  const processors = ["memory_limiter", "k8s_attributes", "batch"];
  const logProcessors = ["memory_limiter", "k8s_attributes", "filter/empty_logs", "batch"];

  return JSON.stringify(
    {
      receivers: {
        filelog: {
          include: ["/var/log/pods/*/*/*.log"],
          // Collector containers only, so the agent does not read its own output back in.
          exclude: args.excludeLogNamespaces.map((ns) => `/var/log/pods/${ns}_*/opentelemetry-collector/*.log`),
          start_at: "end",
          include_file_path: true,
          operators: [{ type: "container", id: "container-parser" }],
        },
        kubelet_stats: {
          collection_interval: interval,
          auth_type: "serviceAccount",
          metric_groups: ["node", "pod", "container", "volume"],
          extra_metadata_labels: ["k8s.volume.type"],
          k8s_api_config: { auth_type: "serviceAccount" },
          // Talos kubelet serves a self-signed certificate.
          endpoint: "https://${env:K8S_NODE_IP}:10250",
          insecure_skip_verify: true,
        },
        host_metrics: {
          collection_interval: interval,
          root_path: "/hostfs",
          scrapers: { cpu: {}, load: {}, memory: {}, disk: {}, network: {} },
        },
        k8s_cluster: { collection_interval: interval },
        k8s_objects: { objects: [{ name: "events", mode: "watch" }] },
        // The receiver refuses to start with no scrape_configs.
        ...(scrapeConfigs.length ? { prometheus: { config: { scrape_configs: scrapeConfigs } } } : {}),
        otlp: { protocols: { grpc: { endpoint: "0.0.0.0:4317" }, http: { endpoint: "0.0.0.0:4318" } } },
      },
      processors: {
        memory_limiter: { check_interval: "5s", limit_percentage: 80, spike_limit_percentage: 25 },
        k8s_attributes: {
          passthrough: false,
          extract: {
            otel_annotations: true,
            metadata: [
              "k8s.namespace.name",
              "k8s.pod.name",
              "k8s.node.name",
              "k8s.deployment.name",
              "k8s.statefulset.name",
              "k8s.daemonset.name",
              "k8s.cronjob.name",
              "k8s.job.name",
              "service.name",
            ],
          },
          pod_association: [
            { sources: [{ from: "resource_attribute", name: "k8s.pod.uid" }] },
            { sources: [{ from: "resource_attribute", name: "k8s.pod.ip" }] },
            { sources: [{ from: "connection" }] },
          ],
        },
        "filter/empty_logs": { error_mode: "ignore", logs: { log_record: ['body == ""'] } },
        batch: {},
      },
      exporters: {
        otlphttp: {
          endpoint: args.gatewayEndpoint,
          compression: "gzip",
          headers: { authorization: `\${env:${args.apiKeyEnvVar}}` },
        },
      },
      service: {
        pipelines: {
          logs: { receivers: ["filelog", "k8s_objects", "otlp"], processors: logProcessors, exporters: ["otlphttp"] },
          metrics: {
            receivers: ["kubelet_stats", "host_metrics", "k8s_cluster", ...(scrapeConfigs.length ? ["prometheus"] : []), "otlp"],
            processors,
            exporters: ["otlphttp"],
          },
          traces: { receivers: ["otlp"], processors, exporters: ["otlphttp"] },
        },
      },
    },
    null,
    2,
  );
}
