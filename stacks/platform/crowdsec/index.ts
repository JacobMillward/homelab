import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import { PlatformCtx } from "../context";

export interface CrowdSecArgs {
  storageClassName: pulumi.Input<string>;
}

export class CrowdSec extends pulumi.ComponentResource {
  readonly bouncerApiKey: pulumi.Output<string>;
  readonly lapiServiceName: pulumi.Output<string>;

  constructor(ctx: PlatformCtx, args: CrowdSecArgs) {
    super("platform:CrowdSec", "crowdsec", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });
    const childOpts = { parent: this };

    const ns = new k8s.core.v1.Namespace(
      "crowdsec",
      {
        metadata: {
          name: "crowdsec",
          labels: {
            "pod-security.kubernetes.io/enforce": "privileged",
            "pod-security.kubernetes.io/audit": "privileged",
            "pod-security.kubernetes.io/warn": "privileged",
          },
        },
      },
      childOpts,
    );

    const bouncerKey = new random.RandomPassword(
      "crowdsec-bouncer-key",
      { length: 32, special: false },
      childOpts,
    );
    this.bouncerApiKey = bouncerKey.result;

    const bouncerSecret = new k8s.core.v1.Secret(
      "crowdsec-bouncer-key",
      {
        metadata: { namespace: ns.metadata.name },
        stringData: { key: this.bouncerApiKey },
      },
      childOpts,
    );

    const release = new k8s.helm.v3.Release(
      "crowdsec",
      {
        name: "crowdsec",
        chart: "crowdsec",
        version: "0.24.2",
        namespace: ns.metadata.name,
        repositoryOpts: {
          repo: "https://crowdsecurity.github.io/helm-charts",
        },
        values: {
          container_runtime: "containerd",
          agent: {
            env: [
              { name: "COLLECTIONS", value: "crowdsecurity/traefik" },
              { name: "PARSERS", value: "crowdsecurity/geoip-enrich" },
            ],
            acquisition: [
              {
                namespace: "traefik",
                podName: "traefik-*",
                program: "traefik",
                poll_without_inotify: true,
              },
            ],
          },
          lapi: {
            env: [
              {
                name: "BOUNCER_KEY_traefik",
                valueFrom: { secretKeyRef: { name: bouncerSecret.metadata.name, key: "key" } },
              },
            ],
            persistentVolume: {
              data: {
                enabled: true,
                storageClassName: args.storageClassName,
                size: "1Gi",
              },
            },
          },
        },
      },
      childOpts,
    );

    this.lapiServiceName = pulumi.interpolate`${release.status.name}-service`;
  }
}
