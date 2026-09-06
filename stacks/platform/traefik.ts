import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { PlatformCtx } from "./context";

export interface TraefikArgs {
  crowdsecBouncerApiKey: pulumi.Input<string>;
}

export class Traefik extends pulumi.ComponentResource {
  readonly loadBalancerIp: string;
  readonly internalIp: pulumi.Output<string>;
  readonly forwardAuthMiddlewareRef: { name: string; namespace: string };
  readonly crowdsecMiddlewareRef: { name: string; namespace: string };

  constructor(ctx: PlatformCtx, args: TraefikArgs) {
    super("platform:Traefik", "traefik", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const config = new pulumi.Config();
    this.loadBalancerIp = config.require("traefikIp");

    const domain = config.require("domain");

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
          experimental: {
            plugins: {
              "crowdsec-bouncer": {
                moduleName: "github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin",
                version: "v1.7.1",
              },
            },
          },
        },
      },
      { parent: this },
    );

    // Wildcard cert for *.${domain} via Let's Encrypt DNS-01
    new k8s.apiextensions.CustomResource(
      "wildcard-cert",
      {
        apiVersion: "cert-manager.io/v1",
        kind: "Certificate",
        metadata: { name: "wildcard-tls", namespace: ns.metadata.name },
        spec: {
          secretName: "wildcard-tls",
          issuerRef: { name: "letsencrypt-prod", kind: "ClusterIssuer" },
          dnsNames: [`*.${domain}`],
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

    new k8s.apiextensions.CustomResource(
      "authelia-forwardauth",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "Middleware",
        metadata: { name: "authelia", namespace: "authelia" },
        spec: {
          forwardAuth: {
            address: "http://idp-authelia.authelia.svc.cluster.local/api/verify?rd=https://auth." + domain,
            trustForwardHeader: true,
            authResponseHeaders: [
              "Remote-User",
              "Remote-Groups",
              "Remote-Name",
              "Remote-Email",
            ],
          },
        },
      },
      { parent: this },
    );

    new k8s.apiextensions.CustomResource(
      "authelia-ingress",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "IngressRoute",
        metadata: { name: "authelia", namespace: "authelia" },
        spec: {
          entryPoints: ["websecure"],
          routes: [
            {
              match: `Host(\`auth.${domain}\`)`,
              kind: "Rule",
              services: [{ name: "idp-authelia", namespace: "authelia", port: 80 }],
            },
          ],
          tls: {},
        },
      },
      { parent: this },
    );

    this.forwardAuthMiddlewareRef = { name: "authelia", namespace: "authelia" };

    new k8s.apiextensions.CustomResource(
      "crowdsec-bouncer-middleware",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "Middleware",
        metadata: { name: "crowdsec-bouncer", namespace: "crowdsec" },
        spec: {
          plugin: {
            "crowdsec-bouncer": {
              enabled: true,
              crowdsecMode: "stream",
              streamStartupBlock: false,
              updateMaxFailure: -1,
              crowdsecLapiKey: args.crowdsecBouncerApiKey,
              crowdsecLapiHost: "crowdsec-service.crowdsec.svc.cluster.local:8080",
              crowdsecLapiScheme: "http",
            },
          },
        },
      },
      { parent: this },
    );
    this.crowdsecMiddlewareRef = { name: "crowdsec-bouncer", namespace: "crowdsec" };

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

