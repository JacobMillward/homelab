import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import * as bcrypt from "bcryptjs";
import { dockerImage } from "homelab-lib";
import { PlatformCtx } from "./context";

export interface RegistryArgs {
  domain: string;
  storageClassName: pulumi.Input<string>;
}

// Self-hosted OCI registry for this repo's own built images, mesh-only like the
// NetBird dashboard. Zot over registry:2 or Harbor: one binary, no external DB.
export class Registry extends pulumi.ComponentResource {
  readonly namespace: k8s.core.v1.Namespace;
  readonly pushHost: pulumi.Output<string>;
  readonly username: pulumi.Output<string>;
  readonly password: pulumi.Output<string>;
  readonly deployment: k8s.apps.v1.Deployment;

  constructor(ctx: PlatformCtx, args: RegistryArgs) {
    super("platform:Registry", "registry", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });
    const childOpts = { parent: this };

    this.namespace = new k8s.core.v1.Namespace(
      "registry",
      { metadata: { name: "registry" } },
      childOpts,
    );

    this.username = pulumi.output("jacob");
    const password = new random.RandomPassword(
      "registry-password",
      { length: 32, special: false },
      childOpts,
    );
    this.password = password.result;

    // Zot expects bcrypt, not APR1. The salt is its own resource so the hash stays
    // stable across runs; bcryptjs would otherwise randomize it on every call.
    const htpasswdSalt = new random.RandomBytes(
      "registry-htpasswd-salt",
      { length: 16 },
      childOpts,
    );
    const htpasswdContent = pulumi
      .all([this.username, this.password, htpasswdSalt.base64])
      .apply(([u, p, saltB64]) => {
        const saltBytes = Array.from(Buffer.from(saltB64, "base64"));
        const salt = `$2b$10$${bcrypt.encodeBase64(saltBytes, 16)}`;
        return `${u}:${bcrypt.hashSync(p, salt)}`;
      });
    const htpasswdSecret = new k8s.core.v1.Secret(
      "registry-htpasswd",
      {
        metadata: { namespace: this.namespace.metadata.name },
        stringData: { htpasswd: htpasswdContent },
      },
      childOpts,
    );

    const config = JSON.stringify({
      distSpecVersion: "1.1.0",
      storage: { rootDirectory: "/var/lib/zot" },
      http: {
        address: "0.0.0.0",
        port: "5000",
        auth: { htpasswd: { path: "/etc/zot/htpasswd" } },
        // Without an anonymousPolicy, htpasswd auth applies even to /v2/, which
        // the readiness probe can't satisfy. Pushes still need auth.
        accessControl: {
          repositories: {
            "**": {
              anonymousPolicy: ["read"],
              defaultPolicy: ["read", "create", "update", "delete"],
            },
          },
        },
      },
      log: { level: "info" },
    });

    const configSecret = new k8s.core.v1.Secret(
      "registry-config",
      {
        metadata: { namespace: this.namespace.metadata.name },
        stringData: { "config.json": config },
      },
      childOpts,
    );

    const dataPvc = new k8s.core.v1.PersistentVolumeClaim(
      "registry-data",
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

    const labels = { app: "registry" };
    this.deployment = new k8s.apps.v1.Deployment(
      "registry",
      {
        metadata: { namespace: this.namespace.metadata.name },
        spec: {
          replicas: 1,
          strategy: { type: "Recreate" },
          progressDeadlineSeconds: 120,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              containers: [
                {
                  name: "zot",
                  image: dockerImage("zot"),
                  ports: [{ name: "http", containerPort: 5000 }],
                  volumeMounts: [
                    { name: "config", mountPath: "/etc/zot/config.json", subPath: "config.json" },
                    { name: "htpasswd", mountPath: "/etc/zot/htpasswd", subPath: "htpasswd" },
                    { name: "data", mountPath: "/var/lib/zot" },
                  ],
                  readinessProbe: {
                    httpGet: { path: "/v2/", port: "http" },
                    initialDelaySeconds: 5,
                    periodSeconds: 10,
                  },
                },
              ],
              volumes: [
                { name: "config", secret: { secretName: configSecret.metadata.name } },
                { name: "htpasswd", secret: { secretName: htpasswdSecret.metadata.name } },
                { name: "data", persistentVolumeClaim: { claimName: dataPvc.metadata.name } },
              ],
            },
          },
        },
      },
      childOpts,
    );

    const svc = new k8s.core.v1.Service(
      "registry",
      {
        metadata: { name: "registry", namespace: this.namespace.metadata.name },
        spec: { selector: labels, ports: [{ name: "http", port: 5000, targetPort: 5000 }] },
      },
      childOpts,
    );

    this.pushHost = pulumi.output(`registry.internal.${args.domain}`);

    new k8s.apiextensions.CustomResource(
      "registry-route",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "IngressRoute",
        metadata: { name: "registry", namespace: this.namespace.metadata.name },
        spec: {
          entryPoints: ["websecure"],
          routes: [
            {
              match: `Host(\`registry.internal.${args.domain}\`)`,
              kind: "Rule",
              services: [{ name: svc.metadata.name, port: 5000 }],
            },
          ],
          tls: {},
        },
      },
      childOpts,
    );
  }
}
