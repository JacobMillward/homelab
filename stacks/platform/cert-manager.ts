import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { helmChart } from "homelab-lib";
import { PlatformCtx } from "./context";

const chart = helmChart("certManager");

export interface CertManagerArgs {
  cloudflareDnsEditApiToken: pulumi.Input<string>;
}

export class CertManager extends pulumi.ComponentResource {
  constructor(ctx: PlatformCtx, args: CertManagerArgs) {
    super("platform:CertManager", "cert-manager", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const cloudflareApiToken = args.cloudflareDnsEditApiToken;

    const ns = new k8s.core.v1.Namespace(
      "cert-manager",
      {
        metadata: { name: "cert-manager" },
      },
      { parent: this },
    );

    const release = new k8s.helm.v3.Release(
      "cert-manager",
      {
        chart: chart.chart,
        version: chart.version,
        namespace: ns.metadata.name,
        repositoryOpts: {
          repo: chart.registryUrl,
        },
        values: {
          crds: { enabled: true },
          strategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
          webhook: {
            strategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
          },
          cainjector: {
            strategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
          },
        },
      },
      { parent: this },
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
      { parent: this },
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
      {
        parent: this,
        dependsOn: [release],
      },
    );
  }
}

