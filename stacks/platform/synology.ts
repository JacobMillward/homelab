import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { PlatformCtx } from "./context";

const NFS_SERVER = "192.168.0.40";

export interface NfsShare {
  /** Logical name used as part of the PV name (e.g. "films" -> "synology-films") */
  name: string;
  /** Absolute path on the NFS server */
  path: string;
  /** Storage capacity label (informational for NFS). Defaults to "100Ti". */
  capacity?: string;
}

const DEFAULT_SHARES: NfsShare[] = [
  { name: "films", path: "/volume1/Media/Films" },
  { name: "tv", path: "/volume1/Media/TV" },
  { name: "music", path: "/volume1/Media/Music" },
];

/**
 * Creates static NFS PersistentVolumes for Synology shares.
 *
 * PVs are cluster-scoped. Apps bind to them by creating a PVC with
 * `volumeName: pvName` and `storageClassName: ""`.
 *
 * Longhorn backup target configuration lives in longhorn.ts.
 */
export class Synology extends pulumi.ComponentResource {
  /** Map of share name to PV name, e.g. { films: "synology-films" } */
  readonly pvNames: Record<string, string>;

  constructor(ctx: PlatformCtx, extraShares: NfsShare[] = []) {
    super("platform:Synology", "synology", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const shares = [...DEFAULT_SHARES, ...extraShares];
    this.pvNames = {};

    for (const share of shares) {
      const pvName = `synology-${share.name}`;

      new k8s.core.v1.PersistentVolume(
        pvName,
        {
          metadata: { name: pvName },
          spec: {
            capacity: { storage: share.capacity ?? "100Ti" },
            accessModes: ["ReadWriteMany"],
            persistentVolumeReclaimPolicy: "Retain",
            storageClassName: "",
            nfs: {
              server: NFS_SERVER,
              path: share.path,
              readOnly: false,
            },
          },
        },
        { parent: this },
      );

      this.pvNames[share.name] = pvName;
    }
  }
}
