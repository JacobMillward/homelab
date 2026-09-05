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

    const release = new k8s.helm.v3.Release(
      "longhorn",
      {
        chart: "longhorn",
        version: "1.11.1",
        namespace: ns.metadata.name,
        repositoryOpts: {
          repo: "https://charts.longhorn.io",
        },
        values: {
          defaultSettings: {
            backupTarget: "nfs://192.168.0.40:/volume1/Backup/longhorn",
            nodeDrainPolicy: "always-allow",
          },
        },
      },
      { parent: this },
    );

    const recurringJobs: [string, string, number][] = [
      ["backup-daily", "0 2 * * *", 7],
      ["backup-weekly", "0 3 * * 0", 4],
      ["backup-monthly", "0 4 1 * *", 12],
    ];

    for (const [name, cron, retain] of recurringJobs) {
      new k8s.apiextensions.CustomResource(
        name,
        {
          apiVersion: "longhorn.io/v1beta2",
          kind: "RecurringJob",
          metadata: { name, namespace: ns.metadata.name },
          spec: {
            task: "backup",
            cron,
            retain,
            concurrency: 1,
            groups: ["default"],
          },
        },
        { parent: this, dependsOn: [release] },
      );
    }
  }
}

/** @deprecated Use `new Longhorn(ctx).storageClassName` */
export const storageClassName = "longhorn";

