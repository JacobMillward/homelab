import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { PlatformCtx } from "./context";

export class Traefik extends pulumi.ComponentResource {
  readonly loadBalancerIp: string;
  readonly internalIp: pulumi.Output<string>;

  constructor(ctx: PlatformCtx) {
    super("platform:Traefik", "traefik", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const config = new pulumi.Config();
    this.loadBalancerIp = config.require("traefikIp");

    const ns = new k8s.core.v1.Namespace(
      "traefik",
      {
        metadata: { name: "traefik" },
      },
      { parent: this },
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
              loadBalancerIP: this.loadBalancerIp,
            },
          },
        },
      },
      { parent: this },
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
          dnsNames: ["*.millward-yuan.net"],
        },
      },
      { parent: this },
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
      {
        parent: this,
        dependsOn: [release],
      },
    );

    // Look up the Helm-created service to reuse its selector
    const helmSvc = k8s.core.v1.Service.get(
      "traefik-helm-svc",
      pulumi.interpolate`${release.status.namespace}/${release.status.name}`,
      { parent: this },
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
      {
        parent: this,
        dependsOn: [release],
      },
    );

    this.internalIp = internalSvc.spec.clusterIP;
  }
}

