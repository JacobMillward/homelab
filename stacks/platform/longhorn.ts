import * as k8s from "@pulumi/kubernetes";

export const storageClassName = "longhorn";

export function deployLonghorn(provider: k8s.Provider) {
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
    { provider },
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
    { provider },
  );
}
