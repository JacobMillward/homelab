import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { PlatformCtx } from "../context";

export interface NetbirdRouterArgs {
  namespace: k8s.core.v1.Namespace;
  storageClassName: string;
  setupKey: pulumi.Output<string>;
}

export class NetbirdRouter extends pulumi.ComponentResource {
  constructor(ctx: PlatformCtx, args: NetbirdRouterArgs) {
    super("platform:netbird:Router", "netbird-router", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const { namespace, storageClassName, setupKey } = args;

    const routerPvc = new k8s.core.v1.PersistentVolumeClaim(
      "netbird-router-config",
      {
        metadata: {
          name: "netbird-router-config",
          namespace: namespace.metadata.name,
        },
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName,
          resources: { requests: { storage: "64Mi" } },
        },
      },
      { parent: this },
    );

    const setupKeySecret = new k8s.core.v1.Secret(
      "netbird-router-key",
      {
        metadata: {
          name: "netbird-router-key",
          namespace: namespace.metadata.name,
        },
        stringData: { setupKey },
      },
      { parent: this },
    );

    new k8s.apps.v1.Deployment(
      "netbird-router",
      {
        metadata: {
          name: "netbird-router",
          namespace: namespace.metadata.name,
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: "netbird-router" } },
          template: {
            metadata: { labels: { app: "netbird-router" } },
            spec: {
              containers: [
                {
                  name: "netbird",
                  image: "netbirdio/netbird:0.66.4",
                  env: [
                    {
                      name: "NB_SETUP_KEY",
                      valueFrom: {
                        secretKeyRef: {
                          name: setupKeySecret.metadata.name,
                          key: "setupKey",
                        },
                      },
                    },
                    {
                      name: "NB_MANAGEMENT_URL",
                      value: "http://netbird-server.netbird.svc.cluster.local",
                    },
                    {
                      name: "NB_HOSTNAME",
                      value: "k8s-router",
                    },
                    {
                      name: "NB_LOG_LEVEL",
                      value: "info",
                    },
                  ],
                  securityContext: {
                    capabilities: {
                      add: ["NET_ADMIN", "SYS_RESOURCE", "SYS_ADMIN"],
                    },
                  },
                  volumeMounts: [{ name: "config", mountPath: "/etc/netbird" }],
                },
              ],
              volumes: [
                {
                  name: "config",
                  persistentVolumeClaim: { claimName: routerPvc.metadata.name },
                },
              ],
            },
          },
        },
      },
      { parent: this },
    );
  }
}
