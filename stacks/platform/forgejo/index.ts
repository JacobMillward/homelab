import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import { dockerImage, RegistryTarget, serviceNameAnnotation } from "homelab-lib";
import { PlatformCtx } from "../context";
import { OidcClientSpec } from "../authelia";
import { CrowdsecPluginSpec, ForwardAuthSpec, PublicDnsSpec, createPublicDnsRecord } from "../traefik";
import { buildForgejoConfig } from "./config";
import {
  PROXY_CONFIG_DIR,
  SPOA_CONFIG_PATH,
  SSH_PUBLIC_PORT,
  buildSpoaBouncerConfig,
  buildSpoeConfig,
  buildSshProxyConfig,
} from "./ssh-proxy";
import {
  GIT_UID,
  configVolume,
  configVolumeMount,
  dataVolumeMount,
  dbEnv,
  pathEnv,
  seedConfigCommand,
} from "./container";
import { createBootstrapJob } from "./bootstrap-job";

export { AUTH_SOURCE_NAME as FORGEJO_AUTH_SOURCE_NAME } from "./bootstrap-job";
import { ForgejoActionSecret, ForgejoPushMirror, ForgejoRepository } from "./api-client";
import { ForgejoAdminToken } from "./admin-token";
import { createRunner } from "./runner";

const containerSecurityContext = {
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] },
};

export interface ForgejoArgs {
  domain: string;
  storageClassName: pulumi.Input<string>;
  oidcClient: OidcClientSpec;
  sshLoadBalancerIp: string;
  crowdsecPluginSpec: CrowdsecPluginSpec;
  crowdsecSpoaBouncerApiKey: pulumi.Output<string>;
  forwardAuthSpec: ForwardAuthSpec;
  githubMirrorToken: pulumi.Input<string>;
  registry: RegistryTarget;
  publicDns: PublicDnsSpec;
  metricsToken: pulumi.Input<string>;
}

export class Forgejo extends pulumi.ComponentResource {
  readonly namespace: k8s.core.v1.Namespace;
  readonly serviceName: pulumi.Output<string>;
  readonly deployment: k8s.apps.v1.Deployment;
  readonly oidcClient: OidcClientSpec;
  readonly adminApiToken: pulumi.Output<string>;
  readonly endpoint: pulumi.Output<string>;
  readonly repoOwner: string;
  readonly repoName: string;

  constructor(ctx: PlatformCtx, args: ForgejoArgs) {
    super("platform:Forgejo", "forgejo", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });
    const childOpts = { parent: this };
    this.oidcClient = args.oidcClient;

    createPublicDnsRecord(this, "git", args.publicDns);

    this.namespace = new k8s.core.v1.Namespace(
      "forgejo",
      {
        metadata: {
          name: "forgejo",
          labels: {
            "pod-security.kubernetes.io/enforce": "privileged",
            "pod-security.kubernetes.io/audit": "privileged",
            "pod-security.kubernetes.io/warn": "privileged",
          },
        },
      },
      childOpts,
    );

    const cluster = new k8s.apiextensions.CustomResource(
      "forgejo-pg",
      {
        apiVersion: "postgresql.cnpg.io/v1",
        kind: "Cluster",
        metadata: { name: "forgejo-pg", namespace: this.namespace.metadata.name },
        spec: {
          instances: 1,
          imageName: "ghcr.io/cloudnative-pg/postgresql:16.9",
          nodeMaintenanceWindow: { inProgress: true, reusePVC: true },
          storage: { size: "5Gi", storageClass: args.storageClassName },
          bootstrap: { initdb: { database: "forgejo", owner: "forgejo" } },
        },
      },
      childOpts,
    );

    // Just the name. CNPG creates this Secret async, so reading its data
    // back directly races Pulumi's apply (confirmed via a real preview failure).
    const dbSecretName = cluster.metadata.name.apply((n) => `${n}-app`);
    const dbHost = cluster.metadata.apply(
      (m) => `${m.name}-rw.${m.namespace}.svc.cluster.local`,
    );

    const secretKey = new random.RandomPassword("forgejo-secret-key", { length: 64, special: false }, childOpts);
    const internalToken = new random.RandomPassword("forgejo-internal-token", { length: 64, special: false }, childOpts);
    // Left unset, Forgejo generates one on demand and tries to persist it
    // back into app.ini, which fails since that file is a read-only mount.
    const jwtSecret = new random.RandomBytes("forgejo-jwt-secret", { length: 32 }, childOpts);

    const config = buildForgejoConfig({
      domain: args.domain,
      secretKey: secretKey.result,
      internalToken: internalToken.result,
      // Forgejo decodes this with base64.RawURLEncoding, not standard base64.
      jwtSecret: jwtSecret.hex.apply((h) => Buffer.from(h, "hex").toString("base64url")),
      dbHost,
      metricsToken: args.metricsToken,
    });

    const configSecret = new k8s.core.v1.Secret(
      "forgejo-config",
      {
        metadata: { namespace: this.namespace.metadata.name },
        stringData: { "app.ini": config },
      },
      childOpts,
    );

    const sshProxyConfig = new k8s.core.v1.ConfigMap(
      "forgejo-ssh-proxy-config",
      {
        metadata: { namespace: this.namespace.metadata.name },
        data: { "haproxy.cfg": buildSshProxyConfig(), "crowdsec.cfg": buildSpoeConfig() },
      },
      childOpts,
    );

    const spoaBouncerConfig = new k8s.core.v1.Secret(
      "forgejo-spoa-bouncer-config",
      {
        metadata: { namespace: this.namespace.metadata.name },
        stringData: {
          "crowdsec-spoa-bouncer.yaml": args.crowdsecSpoaBouncerApiKey.apply((key) =>
            buildSpoaBouncerConfig("http://crowdsec-service.crowdsec.svc.cluster.local:8080/", key),
          ),
        },
      },
      childOpts,
    );

    const dataPvc = new k8s.core.v1.PersistentVolumeClaim(
      "forgejo-data",
      {
        metadata: { namespace: this.namespace.metadata.name },
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName: args.storageClassName,
          resources: { requests: { storage: "20Gi" } },
        },
      },
      childOpts,
    );

    const labels = { app: "forgejo" };
    this.deployment = new k8s.apps.v1.Deployment(
      "forgejo",
      {
        metadata: { namespace: this.namespace.metadata.name },
        spec: {
          replicas: 1,
          strategy: { type: "Recreate" },
          progressDeadlineSeconds: 180,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels, annotations: serviceNameAnnotation("forgejo") },
            spec: {
              securityContext: {
                runAsNonRoot: true,
                runAsUser: GIT_UID,
                runAsGroup: GIT_UID,
                fsGroup: GIT_UID,
                fsGroupChangePolicy: "OnRootMismatch",
                seccompProfile: { type: "RuntimeDefault" },
              },
              initContainers: [
                {
                  name: "seed-config",
                  image: dockerImage("forgejo"),
                  command: seedConfigCommand,
                  securityContext: containerSecurityContext,
                  volumeMounts: [configVolumeMount, dataVolumeMount],
                },
              ],
              containers: [
                {
                  name: "forgejo",
                  image: dockerImage("forgejo"),
                  ports: [{ name: "http", containerPort: 3000 }],
                  env: [...dbEnv(dbSecretName), ...pathEnv],
                  securityContext: containerSecurityContext,
                  resources: {
                    requests: { cpu: "100m", memory: "384Mi" },
                    limits: { memory: "1Gi" },
                  },
                  volumeMounts: [dataVolumeMount, { name: "tmp", mountPath: "/tmp" }],
                  readinessProbe: {
                    httpGet: { path: "/api/healthz", port: "http" },
                    initialDelaySeconds: 15,
                    periodSeconds: 10,
                    failureThreshold: 3,
                  },
                },
                {
                  name: "ssh-proxy",
                  image: dockerImage("haproxy"),
                  ports: [{ name: "ssh", containerPort: SSH_PUBLIC_PORT }],
                  securityContext: containerSecurityContext,
                  resources: {
                    requests: { cpu: "10m", memory: "32Mi" },
                    limits: { memory: "128Mi" },
                  },
                  volumeMounts: [{ name: "ssh-proxy-config", mountPath: PROXY_CONFIG_DIR, readOnly: true }],
                },
                {
                  name: "crowdsec-spoa-bouncer",
                  image: dockerImage("crowdsecSpoaBouncer"),
                  securityContext: containerSecurityContext,
                  resources: {
                    requests: { cpu: "10m", memory: "64Mi" },
                    limits: { memory: "192Mi" },
                  },
                  volumeMounts: [
                    {
                      name: "spoa-bouncer-config",
                      mountPath: SPOA_CONFIG_PATH,
                      subPath: "crowdsec-spoa-bouncer.yaml",
                      readOnly: true,
                    },
                  ],
                },
              ],
              volumes: [
                configVolume(configSecret.metadata.name),
                { name: "data", persistentVolumeClaim: { claimName: dataPvc.metadata.name } },
                { name: "tmp", emptyDir: {} },
                { name: "ssh-proxy-config", configMap: { name: sshProxyConfig.metadata.name } },
                { name: "spoa-bouncer-config", secret: { secretName: spoaBouncerConfig.metadata.name } },
              ],
            },
          },
        },
      },
      childOpts,
    );

    const httpSvc = new k8s.core.v1.Service(
      "forgejo",
      {
        metadata: { name: "forgejo", namespace: this.namespace.metadata.name },
        spec: { selector: labels, ports: [{ name: "http", port: 80, targetPort: 3000 }] },
      },
      childOpts,
    );
    this.serviceName = httpSvc.metadata.name;

    new k8s.core.v1.Service(
      "forgejo-ssh",
      {
        metadata: { name: "forgejo-ssh", namespace: this.namespace.metadata.name },
        spec: {
          type: "LoadBalancer",
          loadBalancerIP: args.sshLoadBalancerIp,
          selector: labels,
          ports: [{ name: "ssh", port: 22, targetPort: SSH_PUBLIC_PORT }],
        },
      },
      childOpts,
    );

    // Same pattern as traefik.ts's authelia-crowdsec-middleware.
    const crowdsecMiddleware = new k8s.apiextensions.CustomResource(
      "forgejo-crowdsec-middleware",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "Middleware",
        metadata: { name: "crowdsec-bouncer", namespace: this.namespace.metadata.name },
        spec: { plugin: { "crowdsec-bouncer": args.crowdsecPluginSpec } },
      },
      childOpts,
    );

    const autheliaMiddleware = new k8s.apiextensions.CustomResource(
      "forgejo-authelia-middleware",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "Middleware",
        metadata: { name: "authelia", namespace: this.namespace.metadata.name },
        spec: { forwardAuth: args.forwardAuthSpec },
      },
      childOpts,
    );

    const headersMiddleware = new k8s.apiextensions.CustomResource(
      "forgejo-headers-middleware",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "Middleware",
        metadata: { name: "security-headers", namespace: this.namespace.metadata.name },
        spec: {
          headers: {
            stsSeconds: 31536000,
            contentTypeNosniff: true,
            customFrameOptionsValue: "SAMEORIGIN",
            referrerPolicy: "same-origin",
          },
        },
      },
      childOpts,
    );

    // CI and PKO share the home IP, so /api gets no limit; only login paths do.
    const authRateLimitMiddleware = new k8s.apiextensions.CustomResource(
      "forgejo-auth-ratelimit-middleware",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "Middleware",
        metadata: { name: "auth-ratelimit", namespace: this.namespace.metadata.name },
        spec: { rateLimit: { average: 10, period: "1s", burst: 20 } },
      },
      childOpts,
    );

    // /metrics has no public route; the agent scrapes the pod directly.
    new k8s.apiextensions.CustomResource(
      "forgejo-route",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "IngressRoute",
        metadata: { name: "forgejo", namespace: this.namespace.metadata.name },
        spec: {
          entryPoints: ["websecure"],
          routes: [
            {
              match: `Host(\`git.${args.domain}\`) && !PathPrefix(\`/metrics\`) && !PathPrefix(\`/-/admin\`)`,
              kind: "Rule",
              services: [{ name: httpSvc.metadata.name, port: 80 }],
              middlewares: [{ name: "crowdsec-bouncer" }, { name: "security-headers" }],
            },
            {
              // Explicit priority: the main rule's negations make it longer, so it would win.
              match: `Host(\`git.${args.domain}\`) && (PathPrefix(\`/user/login\`) || PathPrefix(\`/user/oauth2\`))`,
              kind: "Rule",
              priority: 1000,
              services: [{ name: httpSvc.metadata.name, port: 80 }],
              middlewares: [{ name: "crowdsec-bouncer" }, { name: "auth-ratelimit" }, { name: "security-headers" }],
            },
            {
              match: `Host(\`git.${args.domain}\`) && PathPrefix(\`/-/admin\`)`,
              kind: "Rule",
              services: [{ name: httpSvc.metadata.name, port: 80 }],
              middlewares: [{ name: "crowdsec-bouncer" }, { name: "authelia" }, { name: "security-headers" }],
            },
          ],
          tls: {},
        },
      },
      { ...childOpts, dependsOn: [crowdsecMiddleware, autheliaMiddleware, headersMiddleware, authRateLimitMiddleware] },
    );

    // 40 hex chars: Forgejo requires exactly that for a runner's shared secret.
    const runnerSecret = new random.RandomBytes("forgejo-runner-secret", { length: 20 }, childOpts);
    const imageBuilderSecret = new random.RandomBytes(
      "forgejo-runner-image-builder-secret",
      { length: 20 },
      childOpts,
    );

    const bootstrap = createBootstrapJob(this, {
      namespace: this.namespace.metadata.name,
      deployment: this.deployment,
      configSecretName: configSecret.metadata.name,
      dbSecretName,
      runnerSecret: runnerSecret.hex,
      imageBuilderSecret: imageBuilderSecret.hex,
      domain: args.domain,
      oidcClient: args.oidcClient,
    });
    this.endpoint = pulumi.output(`https://git.${args.domain}`);

    createRunner(this, {
      namespace: this.namespace.metadata.name,
      endpoint: this.endpoint,
      secret: runnerSecret.hex,
      imageBuilderSecret: imageBuilderSecret.hex,
      registry: args.registry,
      dependsOn: [bootstrap.job],
    });

    const adminToken = new ForgejoAdminToken(
      "forgejo-admin-token",
      {
        namespace: this.namespace.metadata.name,
        secretName: bootstrap.adminTokenSecretName,
      },
      { parent: this, dependsOn: [bootstrap.job] },
    );
    this.adminApiToken = adminToken.token;

    const client = { endpoint: this.endpoint, adminToken: this.adminApiToken };
    const repo = new ForgejoRepository(
      "homelab-import",
      {
        client,
        owner: "jacob",
        name: "homelab",
        cloneAddr: "https://github.com/JacobMillward/homelab.git",
        authToken: args.githubMirrorToken,
        private: true,
      },
      { parent: this, dependsOn: [bootstrap.job] },
    );

    new ForgejoPushMirror(
      "homelab-github-mirror",
      {
        client,
        owner: "jacob",
        repo: "homelab",
        remoteAddress: "https://github.com/JacobMillward/homelab.git",
        remoteUsername: "JacobMillward",
        remotePassword: args.githubMirrorToken,
      },
      { parent: this, dependsOn: [repo] },
    );

    // Credentials for .forgejo/workflows/images.yml, which builds and pushes
    // the images the Pulumi programs then only resolve.
    for (const [secretName, data] of [
      ["REGISTRY_USER", args.registry.username],
      ["REGISTRY_PASS", args.registry.password],
    ] as const) {
      new ForgejoActionSecret(
        `registry-${secretName.toLowerCase()}-action-secret`,
        { client, owner: "jacob", repo: "homelab", secretName, data },
        { parent: this, dependsOn: [repo] },
      );
    }

    this.repoOwner = "jacob";
    this.repoName = "homelab";
  }
}
