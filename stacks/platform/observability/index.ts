import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import { helmChart, serviceNameAnnotation } from "homelab-lib";
import { PlatformCtx } from "../context";
import { ForwardAuthSpec } from "../traefik";
import { Agent } from "./agent";
import { buildGatewayCustomConfig } from "./gateway-config";
import { SCRAPE_TARGETS } from "./targets";

const operatorsChart = helmChart("clickstackOperators");
const clickstackChart = helmChart("clickstack");

export interface ObservabilityArgs {
  storageClassName: string;
  noBackupStorageClassName: string;
  domain: string;
  forwardAuthSpec: ForwardAuthSpec;
  // Only exists after the first user registers; deploys use a placeholder until then.
  ingestApiKey?: pulumi.Input<string>;
  forgejoMetricsToken: pulumi.Input<string>;
}

export class Observability extends pulumi.ComponentResource {
  readonly namespace: k8s.core.v1.Namespace;
  readonly gatewayService: pulumi.Output<string>;
  readonly gatewayHost: pulumi.Output<string>;
  readonly ingestApiKey: pulumi.Output<string>;
  readonly hyperdxServiceName: pulumi.Output<string>;
  readonly release: k8s.helm.v3.Release;
  readonly apiEndpoint: string;

  constructor(ctx: PlatformCtx, args: ObservabilityArgs) {
    super("platform:Observability", "observability", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });
    const childOpts = { parent: this };

    this.namespace = new k8s.core.v1.Namespace(
      "observability",
      {
        metadata: {
          name: "observability",
          labels: {
            "pod-security.kubernetes.io/enforce": "baseline",
            "pod-security.kubernetes.io/audit": "baseline",
            "pod-security.kubernetes.io/warn": "baseline",
          },
        },
      },
      childOpts,
    );
    const namespace = this.namespace.metadata.name;

    const apiKey = new random.RandomUuid("hyperdx-api-key", {}, childOpts);
    const password = (name: string) =>
      new random.RandomPassword(name, { length: 32, special: false }, childOpts).result;

    // Rotating this makes stored third-party tokens unreadable, so it must stay stable.
    const tokenEncryptionKey = pulumi.secret(
      new random.RandomId("hyperdx-token-encryption-key", { byteLength: 32 }, childOpts).hex,
    );

    // The release name fixes the generated names: clickstack-otel-collector, clickstack-app.
    const releaseName = "clickstack";

    const operators = new k8s.helm.v3.Release(
      "clickstack-operators",
      {
        name: "clickstack-operators",
        chart: operatorsChart.chart,
        version: operatorsChart.version,
        namespace,
        repositoryOpts: { repo: operatorsChart.registryUrl },
        timeout: 600,
      },
      childOpts,
    );

    const release = new k8s.helm.v3.Release(
      "clickstack",
      {
        name: releaseName,
        chart: clickstackChart.chart,
        version: clickstackChart.version,
        namespace,
        repositoryOpts: { repo: clickstackChart.registryUrl },
        timeout: 900,
        values: {
          global: { otelCollector: { customConfig: buildGatewayCustomConfig() } },
          hyperdx: {
            secrets: {
              HYPERDX_API_KEY: apiKey.result,
              CLICKHOUSE_PASSWORD: password("clickhouse-otel-password"),
              CLICKHOUSE_APP_PASSWORD: password("clickhouse-app-password"),
              MONGODB_PASSWORD: password("mongodb-password"),
              TOKEN_ENCRYPTION_KEY: tokenEncryptionKey,
            },
            config: {
              FRONTEND_URL: `https://hyperdx.internal.${args.domain}`,
              HYPERDX_OTEL_EXPORTER_LOGS_TTL: "30d",
              HYPERDX_OTEL_EXPORTER_METRICS_TTL: "90d",
              HYPERDX_OTEL_EXPORTER_TRACES_TTL: "14d",
              // Without this the TTLs would only apply to newly created tables.
              HYPERDX_OTEL_EXPORTER_RECONCILE_TABLE_TTL: "true",
            },
            deployment: {
              podAnnotations: serviceNameAnnotation("hyperdx"),
              resources: {
                requests: { cpu: "200m", memory: "512Mi" },
                limits: { cpu: "1000m", memory: "2Gi" },
              },
            },
          },
          "otel-collector": { podAnnotations: serviceNameAnnotation("otel-gateway") },
          clickhouse: {
            keeper: {
              spec: {
                annotations: serviceNameAnnotation("clickhouse-keeper"),
                settings: { logger: { level: "warning" } },
                dataVolumeClaimSpec: {
                  storageClassName: args.noBackupStorageClassName,
                  accessModes: ["ReadWriteOnce"],
                  resources: { requests: { storage: "5Gi" } },
                },
              },
            },
            cluster: {
              spec: {
                annotations: serviceNameAnnotation("clickhouse"),
                settings: {
                  extraConfig: {
                    mark_cache_size: 536870912,
                    // metric_log has 1349 columns; one row a second makes thousands of tiny parts whose merges need gigabytes.
                    metric_log: {
                      collect_interval_milliseconds: 60000,
                      flush_interval_milliseconds: 600000,
                    },
                  },
                },
                containerTemplate: {
                  resources: {
                    requests: { cpu: "500m", memory: "4Gi" },
                    limits: { memory: "4Gi" },
                  },
                },
                dataVolumeClaimSpec: {
                  storageClassName: args.noBackupStorageClassName,
                  accessModes: ["ReadWriteOnce"],
                  resources: { requests: { storage: "100Gi" } },
                },
              },
            },
          },
          mongodb: {
            spec: {
              statefulSet: {
                spec: {
                  template: { metadata: { annotations: serviceNameAnnotation("mongodb") } },
                  volumeClaimTemplates: [
                    {
                      metadata: { name: "data-volume" },
                      spec: {
                        storageClassName: args.storageClassName,
                        accessModes: ["ReadWriteOnce"],
                        resources: { requests: { storage: "5Gi" } },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      { ...childOpts, dependsOn: [operators] },
    );

    this.gatewayService = pulumi.output(`${releaseName}-otel-collector`);
    this.gatewayHost = pulumi.interpolate`${releaseName}-otel-collector.${namespace}.svc.cluster.local`;
    this.ingestApiKey = pulumi.secret(pulumi.output(args.ingestApiKey ?? apiKey.result));
    // A same-namespace Middleware, not a cross-namespace ref.
    const autheliaMiddleware = new k8s.apiextensions.CustomResource(
      "hyperdx-authelia-middleware",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "Middleware",
        metadata: { name: "authelia", namespace },
        spec: { forwardAuth: args.forwardAuthSpec },
      },
      childOpts,
    );

    new k8s.apiextensions.CustomResource(
      "hyperdx-route",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "IngressRoute",
        metadata: { name: "hyperdx", namespace },
        spec: {
          entryPoints: ["websecure"],
          routes: [
            {
              match: `Host(\`hyperdx.internal.${args.domain}\`)`,
              kind: "Rule",
              services: [{ name: `${releaseName}-app`, port: 3000 }],
              middlewares: [{ name: "authelia" }],
            },
          ],
          tls: {},
        },
      },
      { ...childOpts, dependsOn: [autheliaMiddleware, release] },
    );

    const apiService = new k8s.core.v1.Service(
      "hyperdx-api",
      {
        metadata: { name: "hyperdx-api", namespace },
        spec: {
          selector: { app: "clickstack", "app.kubernetes.io/instance": "clickstack", "app.kubernetes.io/name": "clickstack" },
          ports: [{ port: 8000, targetPort: 8000 }],
        },
      },
      { ...childOpts, dependsOn: [release] },
    );

    new k8s.apiextensions.CustomResource(
      "hyperdx-api-route",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "IngressRoute",
        metadata: { name: "hyperdx-api", namespace },
        spec: {
          entryPoints: ["websecure"],
          routes: [
            {
              match: `Host(\`hyperdx.internal.${args.domain}\`) && PathPrefix(\`/api/v2\`)`,
              kind: "Rule",
              services: [{ name: apiService.metadata.name, port: 8000 }],
            },
          ],
          tls: {},
        },
      },
      { ...childOpts, dependsOn: [apiService] },
    );

    this.release = release;
    this.apiEndpoint = `https://hyperdx.internal.${args.domain}`;

    new Agent(
      "agent",
      {
        gatewayEndpoint: pulumi.interpolate`http://${this.gatewayHost}:4318`,
        apiKey: this.ingestApiKey,
        scrapeTargets: SCRAPE_TARGETS,
        excludeLogNamespaces: ["observability"],
        secretEnv: [{ name: "FORGEJO_METRICS_TOKEN", value: args.forgejoMetricsToken }],
      },
      { ...childOpts, dependsOn: [release] },
    );
    this.hyperdxServiceName = pulumi.output(`${releaseName}-app`);
  }
}
