import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const DOMAIN = "millward-yuan.net";

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

  const release = new k8s.helm.v3.Release(
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

  // Wildcard cert for *.millward-yuan.net via Let's Encrypt DNS-01
  new k8s.apiextensions.CustomResource(
    "wildcard-cert",
    {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: { name: "wildcard-tls", namespace: ns.metadata.name },
      spec: {
        secretName: "wildcard-tls",
        issuerRef: { name: "letsencrypt-prod", kind: "ClusterIssuer" },
        dnsNames: [`*.${DOMAIN}`],
      },
    },
    { provider },
  );

  // Set the wildcard cert as Traefik's default TLS certificate
  new k8s.apiextensions.CustomResource(
    "default-tls-store",
    {
      apiVersion: "traefik.io/v1alpha1",
      kind: "TLSStore",
      metadata: { name: "default", namespace: ns.metadata.name },
      spec: {
        defaultCertificate: {
          secretName: "wildcard-tls",
        },
      },
    },
    { provider, dependsOn: [release] },
  );

  // Look up the Helm-created service to reuse its selector
  const helmSvc = k8s.core.v1.Service.get(
    "traefik-helm-svc",
    pulumi.interpolate`${release.status.namespace}/${release.status.name}`,
    { provider },
  );

  // ClusterIP service for internal apps (NetBird-only, not LAN-reachable)
  const internalSvc = new k8s.core.v1.Service(
    "traefik-internal",
    {
      metadata: {
        name: "traefik-internal",
        namespace: ns.metadata.name,
      },
      spec: {
        type: "ClusterIP",
        selector: helmSvc.spec.selector,
        ports: [{ name: "websecure", port: 443, targetPort: 8443 }],
      },
    },
    { provider, dependsOn: [release] },
  );

  return {
    namespace: ns,
    loadBalancerIp,
    internalIp: internalSvc.spec.clusterIP,
  };
}
