import * as k8s from "@pulumi/kubernetes";

export function deployPostgresql(provider: k8s.Provider) {
  const ns = new k8s.core.v1.Namespace(
    "cnpg-system",
    {
      metadata: { name: "cnpg-system" },
    },
    { provider },
  );

  new k8s.helm.v3.Release(
    "cnpg",
    {
      chart: "cloudnative-pg",
      version: "0.27.1",
      namespace: ns.metadata.name,
      repositoryOpts: {
        repo: "https://cloudnative-pg.github.io/charts",
      },
    },
    { provider },
  );
}
