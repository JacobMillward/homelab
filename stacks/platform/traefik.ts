import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export function deployTraefik(provider: k8s.Provider) {
  const config = new pulumi.Config();
  const loadBalancerIp = config.require("traefikIp");

  const ns = new k8s.core.v1.Namespace(
    "traefik",
    {
      metadata: { name: "traefik" },
    },
    { provider },
  );

  new k8s.helm.v3.Release(
    "traefik",
    {
      chart: "traefik",
      version: "39.0.6",
      namespace: ns.metadata.name,
      repositoryOpts: {
        repo: "https://traefik.github.io/charts",
      },
      values: {
        service: {
          spec: {
            loadBalancerIP: loadBalancerIp,
          },
        },
      },
    },
    { provider },
  );
}
