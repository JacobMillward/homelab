import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { helmChart, dockerImageRef } from "homelab-lib";
import { buildAgentCollectorConfig, ScrapeTarget } from "./agent-config";
import { AGENT_NAMESPACE, AGENT_SERVICE } from "./agent-endpoint";

const chart = helmChart("otelCollector");
const image = dockerImageRef("otelCollectorContrib");

export interface AgentArgs {
  gatewayEndpoint: pulumi.Input<string>;
  apiKey: pulumi.Input<string>;
  scrapeTargets: ScrapeTarget[];
  excludeLogNamespaces: string[];
  secretEnv?: { name: string; value: pulumi.Input<string> }[];
}

export class Agent extends pulumi.ComponentResource {
  constructor(name: string, args: AgentArgs, opts: pulumi.ComponentResourceOptions) {
    super("platform:observability:Agent", name, {}, opts);
    const childOpts = { parent: this };

    // Own namespace: the only workload that needs hostPath, so the only privileged one.
    const namespace = new k8s.core.v1.Namespace(
      "otel-agent",
      {
        metadata: {
          name: AGENT_NAMESPACE,
          labels: {
            "pod-security.kubernetes.io/enforce": "privileged",
            "pod-security.kubernetes.io/audit": "privileged",
            "pod-security.kubernetes.io/warn": "privileged",
          },
        },
      },
      childOpts,
    );
    const ns = namespace.metadata.name;

    const envSecret = new k8s.core.v1.Secret(
      "otel-agent-env",
      {
        metadata: { name: "otel-agent-env", namespace: ns },
        stringData: {
          HYPERDX_API_KEY: args.apiKey,
          ...Object.fromEntries((args.secretEnv ?? []).map((e) => [e.name, e.value])),
        },
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

    // Daemonset mode publishes every port on the node; nothing here may be reachable from the LAN.
    const noHostPort = { hostPort: null };

    new k8s.helm.v3.Release(
      "otel-agent",
      {
        name: "otel-agent",
        chart: chart.chart,
        version: chart.version,
        namespace: ns,
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
            ...["HYPERDX_API_KEY", ...(args.secretEnv ?? []).map((e) => e.name)].map((name) => ({
              name,
              valueFrom: { secretKeyRef: { name: envSecret.metadata.name, key: name } },
            })),
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
      // The old release owns the cluster-scoped ClusterRole, so it must be deleted first.
      { ...childOpts, deleteBeforeReplace: true },
    );
  }
}
