import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";
import { hash } from "@node-rs/argon2";
import { PlatformCtx } from "../context";
import { buildAutheliaConfig } from "./config";

export interface AutheliaArgs {
  domain: string;
  storageClassName: pulumi.Input<string>;
}

export class Authelia extends pulumi.ComponentResource {
  readonly namespace: k8s.core.v1.Namespace;
  readonly serviceName: pulumi.Output<string>;
  readonly netbirdOidcClientId: pulumi.Output<string>;
  readonly netbirdOidcClientSecret: pulumi.Output<string>;

  constructor(ctx: PlatformCtx, args: AutheliaArgs) {
    super("platform:Authelia", "authelia", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });
    const childOpts = { parent: this };

    this.namespace = new k8s.core.v1.Namespace(
      "authelia",
      { metadata: { name: "authelia" } },
      childOpts,
    );

    const jwtSecret = new random.RandomPassword(
      "authelia-jwt",
      { length: 64, special: false },
      childOpts,
    );
    const sessionSecret = new random.RandomPassword(
      "authelia-session",
      { length: 64, special: false },
      childOpts,
    );
    const storageEncryptionKey = new random.RandomPassword(
      "authelia-storage-key",
      { length: 64, special: false },
      childOpts,
    );
    const oidcHmacSecret = new random.RandomPassword(
      "authelia-oidc-hmac",
      { length: 64, special: false },
      childOpts,
    );
    const oidcIssuerKey = new tls.PrivateKey(
      "authelia-oidc-issuer-key",
      { algorithm: "RSA", rsaBits: 4096 },
      childOpts,
    );
    const netbirdOidcClientId = new random.RandomPassword(
      "netbird-oidc-client-id",
      { length: 32, special: false },
      childOpts,
    );
    const netbirdOidcClientSecret = new random.RandomPassword(
      "netbird-oidc-client-secret",
      { length: 64, special: false },
      childOpts,
    );

    this.netbirdOidcClientId = netbirdOidcClientId.result;
    this.netbirdOidcClientSecret = netbirdOidcClientSecret.result;

    // Single-owner homelab: one argon2id-hashed user, generated once and
    // stored as a Pulumi secret. Rotate by changing this and re-running
    // `pulumi up` — Authelia re-reads the file on pod restart.
    const adminPasswordHash = new random.RandomPassword(
      "authelia-admin-password",
      { length: 24, special: true },
      childOpts,
    );
    const passwordHash = pulumi.secret(
      adminPasswordHash.result.apply((pwd) => hash(pwd)),
    );

    const usersDb = pulumi.interpolate`
users:
  admin:
    displayname: "Admin"
    password: "${passwordHash}"
    email: "admin@${args.domain}"
    groups:
      - "admins"
`;

    const config = buildAutheliaConfig({
      domain: args.domain,
      jwtSecret: jwtSecret.result,
      sessionSecret: sessionSecret.result,
      storageEncryptionKey: storageEncryptionKey.result,
      oidcHmacSecret: oidcHmacSecret.result,
      oidcIssuerPrivateKey: oidcIssuerKey.privateKeyPem,
      netbirdOidcClientId: this.netbirdOidcClientId,
      netbirdOidcClientSecret: this.netbirdOidcClientSecret,
    });

    const configSecret = new k8s.core.v1.Secret(
      "authelia-config",
      {
        metadata: { namespace: this.namespace.metadata.name },
        stringData: {
          "configuration.yml": config,
          "users_database.yml": usersDb,
        },
      },
      childOpts,
    );

    const pvc = new k8s.core.v1.PersistentVolumeClaim(
      "authelia-data",
      {
        metadata: { namespace: this.namespace.metadata.name },
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName: args.storageClassName,
          resources: { requests: { storage: "256Mi" } },
        },
      },
      childOpts,
    );

    const labels = { app: "authelia" };
    new k8s.apps.v1.Deployment(
      "authelia",
      {
        metadata: { namespace: this.namespace.metadata.name },
        spec: {
          replicas: 1,
          strategy: { type: "Recreate" },
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              containers: [
                {
                  name: "authelia",
                  image: "authelia/authelia:4.38",
                  ports: [{ name: "http", containerPort: 9091 }],
                  volumeMounts: [
                    {
                      name: "config",
                      mountPath: "/config/configuration.yml",
                      subPath: "configuration.yml",
                    },
                    {
                      name: "config",
                      mountPath: "/config/users_database.yml",
                      subPath: "users_database.yml",
                    },
                    {
                      name: "data",
                      mountPath: "/data",
                    },
                  ],
                  livenessProbe: {
                    httpGet: { path: "/api/health", port: "http" },
                    initialDelaySeconds: 10,
                  },
                },
              ],
              volumes: [
                { name: "config", secret: { secretName: configSecret.metadata.name } },
                { name: "data", persistentVolumeClaim: { claimName: pvc.metadata.name } },
              ],
            },
          },
        },
      },
      childOpts,
    );

    const svc = new k8s.core.v1.Service(
      "authelia",
      {
        metadata: { name: "idp-authelia", namespace: this.namespace.metadata.name },
        spec: { selector: labels, ports: [{ name: "http", port: 80, targetPort: 9091 }] },
      },
      childOpts,
    );
    this.serviceName = svc.metadata.name;
  }
}
