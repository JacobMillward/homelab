import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { helmChart } from "homelab-lib";
import { PlatformCtx } from "./context";

const chart = helmChart("longhorn");

export class Longhorn extends pulumi.ComponentResource {
  readonly storageClassName = "longhorn";
  readonly noBackupStorageClassName = "longhorn-no-backup";

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
        chart: chart.chart,
        version: chart.version,
        namespace: ns.metadata.name,
        repositoryOpts: {
          repo: chart.registryUrl,
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

    // Joins no group. Its label is what keeps volumes off the "default" group (Longhorn
    // adds a volume to it only when the volume has no recurring job), so the backups skip them.
    const noBackupJob = new k8s.apiextensions.CustomResource(
      "telemetry-snapshot-cleanup",
      {
        apiVersion: "longhorn.io/v1beta2",
        kind: "RecurringJob",
        metadata: { name: "telemetry-snapshot-cleanup", namespace: ns.metadata.name },
        spec: { task: "snapshot-cleanup", cron: "0 5 * * *", retain: 0, concurrency: 1, groups: [] },
      },
      { parent: this, dependsOn: [release] },
    );

    new k8s.storage.v1.StorageClass(
      "longhorn-no-backup",
      {
        metadata: { name: this.noBackupStorageClassName },
        provisioner: "driver.longhorn.io",
        allowVolumeExpansion: true,
        reclaimPolicy: "Delete",
        volumeBindingMode: "Immediate",
        // One replica: the cluster has a single node, so more would stay unschedulable.
        parameters: {
          numberOfReplicas: "1",
          staleReplicaTimeout: "30",
          fsType: "ext4",
          dataEngine: "v1",
          disableRevisionCounter: "true",
          backupTargetName: "default",
          recurringJobSelector: '[{"name":"telemetry-snapshot-cleanup","isGroup":false}]',
        },
      },
      { parent: this, dependsOn: [noBackupJob] },
    );

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

