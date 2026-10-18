import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import * as bcrypt from "bcryptjs";
import { dockerImage } from "homelab-lib";
import { PlatformCtx } from "./context";
import { CrowdsecPluginSpec, PublicDnsSpec, createPublicDnsRecord } from "./traefik";
import { buildNtfyServerConfig } from "./ntfy-config";

export interface NtfyArgs {
  domain: string;
  storageClassName: pulumi.Input<string>;
  crowdsecPluginSpec: CrowdsecPluginSpec;
  publicDns: PublicDnsSpec;
}

export const ALERTS_TOPIC = "alerts";
const PORT = 8080;

export class Ntfy extends pulumi.ComponentResource {
  readonly serviceUrl: string;
  readonly publisherToken: pulumi.Output<string>;
  readonly phonePassword: pulumi.Output<string>;

  constructor(ctx: PlatformCtx, args: NtfyArgs) {
    super("platform:Ntfy", "ntfy", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });
    const childOpts = { parent: this };

    const namespace = new k8s.core.v1.Namespace("ntfy", { metadata: { name: "ntfy" } }, childOpts);
    const ns = namespace.metadata.name;
    this.serviceUrl = "http://ntfy.ntfy.svc.cluster.local";

    const user = (name: string) => {
      const password = new random.RandomPassword(`ntfy-${name}-password`, { length: 32, special: false }, childOpts);
      const salt = new random.RandomBytes(`ntfy-${name}-salt`, { length: 16 }, childOpts);
      const hash = pulumi.all([password.result, salt.base64]).apply(([p, saltB64]) => {
        const saltBytes = Array.from(Buffer.from(saltB64, "base64"));
        return bcrypt.hashSync(p, `$2a$10$${bcrypt.encodeBase64(saltBytes, 16)}`);
      });
      return { password: password.result, hash };
    };
    const phone = user("phone");
    const hyperdx = user("hyperdx");
    this.phonePassword = phone.password;

    const tokenSuffix = new random.RandomString(
      "ntfy-hyperdx-token",
      { length: 29, special: false, upper: false },
      childOpts,
    );
    this.publisherToken = pulumi.secret(tokenSuffix.result.apply((s) => `tk_${s}`));

    const config = pulumi
      .all([phone.hash, hyperdx.hash, this.publisherToken])
      .apply(([phoneHash, hyperdxHash, token]) =>
        buildNtfyServerConfig({
          baseUrl: `https://ntfy.${args.domain}`,
          users: [
            { name: "phone", passwordHash: phoneHash, role: "user" },
            { name: "hyperdx", passwordHash: hyperdxHash, role: "user" },
          ],
          tokens: [{ user: "hyperdx", token, label: "HyperDX alerts" }],
          access: [
            { user: "phone", topic: ALERTS_TOPIC, permission: "read-only" },
            { user: "hyperdx", topic: ALERTS_TOPIC, permission: "write-only" },
          ],
        }),
      );
    const configSecret = new k8s.core.v1.Secret(
      "ntfy-config",
      { metadata: { namespace: ns }, stringData: { "server.yml": config } },
      childOpts,
    );

    const dataPvc = new k8s.core.v1.PersistentVolumeClaim(
      "ntfy-data",
      {
        metadata: { namespace: ns },
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName: args.storageClassName,
          resources: { requests: { storage: "2Gi" } },
        },
      },
      childOpts,
    );

    const labels = { app: "ntfy" };
    const deployment = new k8s.apps.v1.Deployment(
      "ntfy",
      {
        metadata: { namespace: ns },
        spec: {
          replicas: 1,
          // The SQLite files live on one RWO volume.
          strategy: { type: "Recreate" },
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
              containers: [
                {
                  name: "ntfy",
                  image: dockerImage("ntfy"),
                  args: ["serve"],
                  ports: [{ name: "http", containerPort: PORT }],
                  readinessProbe: { httpGet: { path: "/v1/health", port: PORT }, periodSeconds: 10 },
                  livenessProbe: { httpGet: { path: "/v1/health", port: PORT }, initialDelaySeconds: 10, periodSeconds: 30 },
                  resources: { requests: { cpu: "20m", memory: "64Mi" }, limits: { memory: "256Mi" } },
                  volumeMounts: [
                    { name: "config", mountPath: "/etc/ntfy/server.yml", subPath: "server.yml", readOnly: true },
                    { name: "data", mountPath: "/var/lib/ntfy" },
                  ],
                },
              ],
              volumes: [
                { name: "config", secret: { secretName: configSecret.metadata.name } },
                { name: "data", persistentVolumeClaim: { claimName: dataPvc.metadata.name } },
              ],
            },
          },
        },
      },
      childOpts,
    );

    const service = new k8s.core.v1.Service(
      "ntfy",
      {
        metadata: { name: "ntfy", namespace: ns },
        spec: { selector: labels, ports: [{ name: "http", port: 80, targetPort: PORT }] },
      },
      { ...childOpts, dependsOn: [deployment] },
    );

    const crowdsecMiddleware = new k8s.apiextensions.CustomResource(
      "ntfy-crowdsec-middleware",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "Middleware",
        metadata: { name: "crowdsec-bouncer", namespace: ns },
        spec: { plugin: { "crowdsec-bouncer": args.crowdsecPluginSpec } },
      },
      childOpts,
    );

    new k8s.apiextensions.CustomResource(
      "ntfy-route",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "IngressRoute",
        metadata: { name: "ntfy", namespace: ns },
        spec: {
          entryPoints: ["websecure"],
          routes: [
            {
              match: `Host(\`ntfy.${args.domain}\`)`,
              kind: "Rule",
              services: [{ name: service.metadata.name, port: 80 }],
              middlewares: [{ name: "crowdsec-bouncer" }],
            },
          ],
          tls: {},
        },
      },
      { ...childOpts, dependsOn: [crowdsecMiddleware] },
    );

    createPublicDnsRecord(this, "ntfy", args.publicDns);
  }
}
