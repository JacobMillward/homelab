import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { PlatformCtx } from "./context";

export class PostgreSQL extends pulumi.ComponentResource {
  constructor(ctx: PlatformCtx) {
    super("platform:PostgreSQL", "postgresql", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const ns = new k8s.core.v1.Namespace(
      "cnpg-system",
      {
        metadata: { name: "cnpg-system" },
      },
      { parent: this },
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
      { parent: this },
    );
  }
}

