import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { helmChart, dockerImageRef } from "homelab-lib";
import { buildAgentCollectorConfig, ScrapeTarget } from "./agent-config";

const chart = helmChart("otelCollector");
const image = dockerImageRef("otelCollectorContrib");

export interface AgentArgs {
  namespace: pulumi.Input<string>;
  gatewayEndpoint: pulumi.Input<string>;
  apiKey: pulumi.Input<string>;
  scrapeTargets: ScrapeTarget[];
  excludeLogNamespaces: string[];
  // Extra env vars read from existing Secrets (scrape bearer tokens).
  secretEnv?: { name: string; secretName: pulumi.Input<string>; key: string }[];
}

export const AGENT_SERVICE = "otel-agent";
// Static so Traefik (created before Observability) can point at it.
export const AGENT_OTLP_ENDPOINT = `http://${AGENT_SERVICE}.observability.svc.cluster.local:4318`;

export class Agent extends pulumi.ComponentResource {
  constructor(name: string, args: AgentArgs, opts: pulumi.ComponentResourceOptions) {
    super("platform:observability:Agent", name, {}, opts);
    const childOpts = { parent: this };

    const keySecret = new k8s.core.v1.Secret(
      "otel-agent-api-key",
      {
        metadata: { name: "otel-agent-api-key", namespace: args.namespace },
        stringData: { HYPERDX_API_KEY: args.apiKey },
      },
      childOpts,
    );

    const config = pulumi.output(args.gatewayEndpoint).apply((gatewayEndpoint) =>
      JSON.parse(
        buildAgentCollectorConfig({
          gatewayEndpoint,
          apiKeyEnvVar: "HYPERDX_API_KEY",
          scrapeTargets: args.scrapeTargets,
          scrapeIntervalSeconds: 30,
          excludeLogNamespaces: args.excludeLogNamespaces,
        }),
      ),
    );

    // Daemonset mode publishes every port on the node by default; nothing here should be
    // reachable from the LAN, so hostPort is cleared and the unused receivers are dropped.
    const noHostPort = { hostPort: null };

    new k8s.helm.v3.Release(
      "otel-agent",
      {
        name: "otel-agent",
        chart: chart.chart,
        version: chart.version,
        namespace: args.namespace,
        repositoryOpts: { repo: chart.registryUrl },
        values: {
          mode: "daemonset",
          fullnameOverride: AGENT_SERVICE,
          image: { repository: image.image, tag: image.tag, digest: image.digest },
          command: { name: "otelcol-contrib" },
          service: { enabled: true },
          ports: {
            otlp: noHostPort,
            "otlp-http": noHostPort,
            "jaeger-compact": { enabled: false, ...noHostPort },
            "jaeger-thrift": { enabled: false, ...noHostPort },
            "jaeger-grpc": { enabled: false, ...noHostPort },
            zipkin: { enabled: false, ...noHostPort },
          },
          config: pulumi.output(config).apply((c) => ({ ...c, receivers: { ...c.receivers, jaeger: null, zipkin: null } })),
          clusterRole: {
            create: true,
            rules: [
              { apiGroups: [""], resources: ["pods", "namespaces", "nodes", "nodes/proxy", "nodes/stats", "services", "endpoints", "events", "resourcequotas", "replicationcontrollers", "persistentvolumeclaims", "persistentvolumes"], verbs: ["get", "list", "watch"] },
              { apiGroups: ["apps"], resources: ["replicasets", "deployments", "daemonsets", "statefulsets"], verbs: ["get", "list", "watch"] },
              { apiGroups: ["batch"], resources: ["jobs", "cronjobs"], verbs: ["get", "list", "watch"] },
              { apiGroups: ["autoscaling"], resources: ["horizontalpodautoscalers"], verbs: ["get", "list", "watch"] },
              { apiGroups: ["events.k8s.io"], resources: ["events"], verbs: ["get", "list", "watch"] },
            ],
          },
          // Reads root-owned container logs under /var/log/pods.
          securityContext: { runAsUser: 0, runAsGroup: 0 },
          extraEnvs: [
            { name: "K8S_NODE_IP", valueFrom: { fieldRef: { fieldPath: "status.hostIP" } } },
            { name: "HYPERDX_API_KEY", valueFrom: { secretKeyRef: { name: keySecret.metadata.name, key: "HYPERDX_API_KEY" } } },
            ...(args.secretEnv ?? []).map((e) => ({ name: e.name, valueFrom: { secretKeyRef: { name: e.secretName, key: e.key } } })),
          ],
          extraVolumes: [
            { name: "varlogpods", hostPath: { path: "/var/log/pods" } },
            { name: "hostproc", hostPath: { path: "/proc" } },
            { name: "hostsys", hostPath: { path: "/sys" } },
          ],
          extraVolumeMounts: [
            { name: "varlogpods", mountPath: "/var/log/pods", readOnly: true },
            // Only /proc and /sys, not the host root: a compromised collector could read node secrets.
            { name: "hostproc", mountPath: "/hostfs/proc", readOnly: true },
            { name: "hostsys", mountPath: "/hostfs/sys", readOnly: true },
          ],
          resources: {
            requests: { cpu: "100m", memory: "256Mi" },
            limits: { memory: "1Gi" },
          },
        },
      },
      childOpts,
    );
  }
}
