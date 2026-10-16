import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import { helmChart } from "homelab-lib";
import { PlatformCtx } from "../context";
import { ForwardAuthSpec } from "../traefik";
import { Agent, AGENT_OTLP_ENDPOINT } from "./agent";
import { SCRAPE_TARGETS } from "./targets";

const operatorsChart = helmChart("clickstackOperators");
const clickstackChart = helmChart("clickstack");

export interface ObservabilityArgs {
  storageClassName: string;
  noBackupStorageClassName: string;
  domain: string;
  forwardAuthSpec: ForwardAuthSpec;
  // Team API key from HyperDX Settings. It only exists after the first user registers,
  // so deploys use a placeholder until it is set.
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
          // The node collector mounts hostPath volumes (container logs, host metrics).
          labels: {
            "pod-security.kubernetes.io/enforce": "privileged",
            "pod-security.kubernetes.io/audit": "privileged",
            "pod-security.kubernetes.io/warn": "privileged",
          },
        },
      },
      childOpts,
    );
    const namespace = this.namespace.metadata.name;

    const apiKey = new random.RandomUuid("hyperdx-api-key", {}, childOpts);
    const password = (name: string) =>
      new random.RandomPassword(name, { length: 32, special: false }, childOpts).result;

    // Release name "clickstack" makes the chart's generated names static:
    // clickstack-otel-collector (gateway) and clickstack-app (HyperDX).
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
          hyperdx: {
            secrets: {
              HYPERDX_API_KEY: apiKey.result,
              CLICKHOUSE_PASSWORD: password("clickhouse-otel-password"),
              CLICKHOUSE_APP_PASSWORD: password("clickhouse-app-password"),
              MONGODB_PASSWORD: password("mongodb-password"),
            },
            config: {
              FRONTEND_URL: `https://hyperdx.internal.${args.domain}`,
              HYPERDX_OTEL_EXPORTER_LOGS_TTL: "30d",
              HYPERDX_OTEL_EXPORTER_METRICS_TTL: "90d",
              HYPERDX_OTEL_EXPORTER_TRACES_TTL: "14d",
              // Without this the TTLs would only apply to newly created tables.
              HYPERDX_OTEL_EXPORTER_RECONCILE_TABLE_TTL: "true",
            },
            // Alert checks never run unless this is on.
            tasks: { enabled: true },
            deployment: {
              resources: {
                requests: { cpu: "200m", memory: "512Mi" },
                limits: { cpu: "1000m", memory: "2Gi" },
              },
            },
          },
          clickhouse: {
            keeper: {
              spec: {
                dataVolumeClaimSpec: {
                  storageClassName: args.noBackupStorageClassName,
                  accessModes: ["ReadWriteOnce"],
                  resources: { requests: { storage: "5Gi" } },
                },
              },
            },
            cluster: {
              spec: {
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
    // Mesh-only (traefik-internal) with Authelia on top, like the NetBird dashboard.
    // HyperDX keeps its own local accounts (no OIDC for the UI), so the first visit
    // creates a user. A same-namespace Middleware, not a cross-namespace ref.
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

    this.release = release;

    const forgejoMetricsSecret = new k8s.core.v1.Secret(
      "forgejo-metrics-token",
      {
        metadata: { name: "forgejo-metrics-token", namespace },
        stringData: { token: args.forgejoMetricsToken },
      },
      childOpts,
    );

    new Agent(
      "agent",
      {
        namespace,
        gatewayEndpoint: pulumi.interpolate`http://${this.gatewayHost}:4318`,
        apiKey: this.ingestApiKey,
        scrapeTargets: SCRAPE_TARGETS,
        excludeLogNamespaces: ["observability"],
        secretEnv: [{ name: "FORGEJO_METRICS_TOKEN", secretName: forgejoMetricsSecret.metadata.name, key: "token" }],
      },
      { ...childOpts, dependsOn: [release] },
    );
    this.hyperdxServiceName = pulumi.output(`${releaseName}-app`);
  }
}
