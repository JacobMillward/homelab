import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { PlatformCtx } from "./context";

export class Longhorn extends pulumi.ComponentResource {
  readonly storageClassName = "longhorn";

  constructor(ctx: PlatformCtx) {
    super("platform:Longhorn", "longhorn", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const ns = new k8s.core.v1.Namespace(
      "longhorn-system",
      {
        metadata: {
          name: "longhorn-system",
          labels: {
            "pod-security.kubernetes.io/enforce": "privileged",
            "pod-security.kubernetes.io/audit": "privileged",
            "pod-security.kubernetes.io/warn": "privileged",
          },
        },
      },
      { parent: this },
    );

    new k8s.helm.v3.Release(
      "longhorn",
      {
        chart: "longhorn",
        version: "1.11.1",
        namespace: ns.metadata.name,
        repositoryOpts: {
          repo: "https://charts.longhorn.io",
        },
      },
      { parent: this },
    );
  }
}

/** @deprecated Use `new Longhorn(ctx).storageClassName` */
export const storageClassName = "longhorn";

