import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { helmChart } from "homelab-lib";
import { PlatformCtx } from "./context";

const chart = helmChart("postgresql");

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
        chart: chart.chart,
        version: chart.version,
        namespace: ns.metadata.name,
        repositoryOpts: {
          repo: chart.registryUrl,
        },
      },
      { parent: this },
    );
  }
}

