import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { AppCtx } from "../app";

export class Joplin extends pulumi.ComponentResource {
  constructor(ctx: AppCtx) {
    super(
      "apps:Joplin",
      "joplin",
      {},
      {
        providers: { kubernetes: ctx.provider },
      },
    );

    const config = new pulumi.Config();
    const host = `joplin.${config.require("domain")}`;
    const childOpts = { parent: this };

    const ns = new k8s.core.v1.Namespace(
      "joplin",
      {},
      { ...childOpts },
    );

    const cluster = new k8s.apiextensions.CustomResource(
      "joplin-pg",
      {
        apiVersion: "postgresql.cnpg.io/v1",
        kind: "Cluster",
        metadata: {
          name: "joplin-pg",
          namespace: ns.metadata.name,
        },
        spec: {
          instances: 1,
          imageName: "ghcr.io/cloudnative-pg/postgresql:16.9",
          storage: {
            size: "5Gi",
            storageClass: ctx.storageClassName,
          },
          bootstrap: {
            initdb: {
              database: "joplin",
              owner: "joplin",
            },
          },
        },
      },
      { ...childOpts },
    );

    const dbSecretName = cluster.metadata.name.apply((n) => `${n}-app`);
    const dbHost = cluster.metadata.apply(
      (m) => `${m.name}-rw.${m.namespace}.svc.cluster.local`,
    );

    const labels = { app: "joplin-server" };

    new k8s.apps.v1.Deployment(
      "joplin-server",
      {
        metadata: {
          namespace: ns.metadata.name,
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: labels },
          template: {
            metadata: { labels },
            spec: {
              containers: [
                {
                  name: "joplin-server",
                  image: "joplin/server:3.5.2",
                  ports: [{ name: "http", containerPort: 22300 }],
                  livenessProbe: {
                    httpGet: { path: "/api/ping", port: "http" },
                    initialDelaySeconds: 30,
                    periodSeconds: 20,
                  },
                  readinessProbe: {
                    httpGet: { path: "/api/ping", port: "http" },
                    initialDelaySeconds: 10,
                    periodSeconds: 10,
                  },
                  env: [
                    { name: "APP_PORT", value: "22300" },
                    {
                      name: "APP_BASE_URL",
                      value: `https://${host}`,
                    },
                    { name: "MAILER_ENABLED", value: "0" },
                    { name: "DB_CLIENT", value: "pg" },
                    { name: "POSTGRES_HOST", value: dbHost },
                    { name: "POSTGRES_PORT", value: "5432" },
                    {
                      name: "POSTGRES_USER",
                      valueFrom: {
                        secretKeyRef: {
                          name: dbSecretName,
                          key: "username",
                        },
                      },
                    },
                    {
                      name: "POSTGRES_PASSWORD",
                      valueFrom: {
                        secretKeyRef: {
                          name: dbSecretName,
                          key: "password",
                        },
                      },
                    },
                    { name: "POSTGRES_DATABASE", value: "joplin" },
                  ],
                },
              ],
            },
          },
        },
      },
      { ...childOpts },
    );

    const svc = new k8s.core.v1.Service(
      "joplin",
      {
        metadata: {
          namespace: ns.metadata.name,
        },
        spec: {
          selector: labels,
          ports: [{ name: "http", port: 22300, targetPort: 22300 }],
        },
      },
      { ...childOpts },
    );

    ctx.dns.expose("joplin", {
      host,
      namespace: ns.metadata.name,
      serviceName: svc.metadata.name,
      servicePort: 22300,
      parent: this,
    });
  }
}
