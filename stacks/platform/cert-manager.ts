import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export function deployCertManager(
  provider: k8s.Provider,
  cloudflareApiToken: pulumi.Output<string>,
) {
  const ns = new k8s.core.v1.Namespace(
    "cert-manager",
    {
      metadata: { name: "cert-manager" },
    },
    { provider },
  );

  const release = new k8s.helm.v3.Release(
    "cert-manager",
    {
      chart: "cert-manager",
      version: "v1.20.0",
      namespace: ns.metadata.name,
      repositoryOpts: {
        repo: "https://charts.jetstack.io",
      },
      values: {
        crds: { enabled: true },
      },
    },
    { provider },
  );

  const cfSecret = new k8s.core.v1.Secret(
    "cloudflare-api-token",
    {
      metadata: {
        name: "cloudflare-api-token",
        namespace: ns.metadata.name,
      },
      stringData: {
        "api-token": cloudflareApiToken,
      },
    },
    { provider },
  );

  new k8s.apiextensions.CustomResource(
    "letsencrypt-prod",
    {
      apiVersion: "cert-manager.io/v1",
      kind: "ClusterIssuer",
      metadata: { name: "letsencrypt-prod" },
      spec: {
        acme: {
          server: "https://acme-v02.api.letsencrypt.org/directory",
          email: "jacob@millward.dev",
          privateKeySecretRef: { name: "letsencrypt-prod-account-key" },
          solvers: [
            {
              dns01: {
                cloudflare: {
                  apiTokenSecretRef: {
                    name: cfSecret.metadata.name,
                    key: "api-token",
                  },
                },
              },
            },
          ],
        },
      },
    },
    { provider, dependsOn: [release] },
  );
}
