import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { PlatformCtx } from "./context";

export class MetalLB extends pulumi.ComponentResource {
  constructor(ctx: PlatformCtx) {
    super("platform:MetalLB", "metallb", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const config = new pulumi.Config();
    const addresses = config.require("metallbAddresses");

    const ns = new k8s.core.v1.Namespace(
      "metallb-system",
      {
        metadata: {
          name: "metallb-system",
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
      "metallb",
      {
        chart: "metallb",
        version: "0.15.3",
        namespace: ns.metadata.name,
        repositoryOpts: {
          repo: "https://metallb.github.io/metallb",
        },
        values: {
          speaker: {
            // Talos labels control plane nodes with
            // node.kubernetes.io/exclude-from-external-load-balancers
            // which makes the speaker skip them. This flag overrides that.
            ignoreExcludeLB: true,
          },
        },
      },
      { parent: this },
    );

    new k8s.apiextensions.CustomResource(
      "metallb-ip-pool",
      {
        apiVersion: "metallb.io/v1beta1",
        kind: "IPAddressPool",
        metadata: {
          name: "default-pool",
          namespace: ns.metadata.name,
        },
        spec: {
          addresses: [addresses],
        },
      },
      {
        parent: this,
        dependsOn: [release],
      },
    );

    new k8s.apiextensions.CustomResource(
      "metallb-l2-advertisement",
      {
        apiVersion: "metallb.io/v1beta1",
        kind: "L2Advertisement",
        metadata: {
          name: "default",
          namespace: ns.metadata.name,
        },
        spec: {
          ipAddressPools: ["default-pool"],
        },
      },
      {
        parent: this,
        dependsOn: [release],
      },
    );
  }
}

