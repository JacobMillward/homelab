import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { DnsRegistrar } from "../dns";
interface JoplinArgs {
  provider: k8s.Provider;
  storageClassName: pulumi.Output<string>;
  dns: DnsRegistrar;
  traefikInternalIp: pulumi.Output<string>;
}

export function deployJoplin(args: JoplinArgs) {
  const { provider, storageClassName, dns, traefikInternalIp } = args;
  const host = "joplin.millward-yuan.net";

  const ns = new k8s.core.v1.Namespace(
    "joplin",
    {
      metadata: { name: "joplin" },
    },
    { provider },
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
          storageClass: storageClassName,
        },
        bootstrap: {
          initdb: {
            database: "joplin",
            owner: "joplin",
          },
        },
      },
    },
    { provider },
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
        name: "joplin-server",
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
                ports: [{ containerPort: 22300 }],
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
    { provider },
  );

  const svc = new k8s.core.v1.Service(
    "joplin",
    {
      metadata: {
        name: "joplin",
        namespace: ns.metadata.name,
      },
      spec: {
        selector: labels,
        ports: [{ name: "http", port: 22300, targetPort: 22300 }],
      },
    },
    { provider },
  );

  new k8s.apiextensions.CustomResource(
    "joplin-ingress",
    {
      apiVersion: "traefik.io/v1alpha1",
      kind: "IngressRoute",
      metadata: {
        name: "joplin",
        namespace: ns.metadata.name,
      },
      spec: {
        entryPoints: ["websecure"],
        routes: [
          {
            match: `Host(\`${host}\`)`,
            kind: "Rule",
            services: [{ name: svc.metadata.name, port: 22300 }],
          },
        ],
        tls: {},
      },
    },
    { provider },
  );

  // Points at Traefik's internal ClusterIP, only reachable via NetBird
  dns.register("joplin", traefikInternalIp);
}
