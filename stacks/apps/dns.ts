import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as cloudflare from "@pulumi/cloudflare";
import * as netbird from "@pulumi/netbird";

interface DnsRegistrarArgs {
  domain: string;
  managementUrl: pulumi.Output<string>;
  pat: pulumi.Output<string>;
  dnsZoneId: pulumi.Output<string>;
  traefikInternalIp: pulumi.Output<string>;
  cloudflareApiToken: pulumi.Output<string>;
  vpsIp: pulumi.Output<string>;
  forwardAuthMiddlewareRef: pulumi.Input<{ name: string; namespace: string }>;
}

export class DnsRegistrar {
  private netbirdProvider: netbird.Provider;
  private cloudflareProvider: cloudflare.Provider;
  private cloudflareZoneId: pulumi.Output<string>;
  private domain: string;
  private zoneId: pulumi.Output<string>;
  private traefikInternalIp: pulumi.Output<string>;
  private vpsIp: pulumi.Output<string>;
  private forwardAuthMiddlewareRef: pulumi.Input<{ name: string; namespace: string }>;

  constructor(args: DnsRegistrarArgs) {
    this.netbirdProvider = new netbird.Provider("netbird", {
      managementUrl: args.managementUrl,
      token: args.pat,
    });
    this.cloudflareProvider = new cloudflare.Provider("cloudflare", {
      apiToken: args.cloudflareApiToken,
    });
    this.cloudflareZoneId = cloudflare
      .getZoneOutput({ filter: { name: args.domain } }, { provider: this.cloudflareProvider })
      .apply((z) => z.id);
    this.domain = args.domain;
    this.zoneId = args.dnsZoneId;
    this.traefikInternalIp = args.traefikInternalIp;
    this.vpsIp = args.vpsIp;
    this.forwardAuthMiddlewareRef = args.forwardAuthMiddlewareRef;
  }

  private registerInternal(name: string, ip: pulumi.Input<string>) {
    return new netbird.DnsRecord(
      `${name}-dns`,
      {
        name: `${name}.${this.domain}`,
        zoneId: this.zoneId,
        type: "A",
        content: ip,
        ttl: 300,
      },
      { provider: this.netbirdProvider },
    );
  }

  private registerPublic(name: string, ip: pulumi.Input<string>) {
    return new cloudflare.DnsRecord(
      `${name}-public-dns`,
      {
        zoneId: this.cloudflareZoneId,
        name: `${name}.${this.domain}`,
        type: "A",
        content: ip,
        proxied: false,
        ttl: 300,
      },
      { provider: this.cloudflareProvider },
    );
  }

  private createIngressRoute(
    name: string,
    opts: {
      host: string;
      namespace: pulumi.Input<string>;
      serviceName: pulumi.Input<string>;
      servicePort: number;
      parent: pulumi.Resource;
    },
  ) {
    new k8s.apiextensions.CustomResource(
      `${name}-ingress`,
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "IngressRoute",
        metadata: { name, namespace: opts.namespace },
        spec: {
          entryPoints: ["websecure"],
          routes: [
            {
              match: `Host(\`${opts.host}\`)`,
              kind: "Rule",
              services: [{ name: opts.serviceName, port: opts.servicePort }],
              middlewares: [this.forwardAuthMiddlewareRef],
            },
          ],
          tls: {},
        },
      },
      { parent: opts.parent },
    );
  }

  expose(
    name: string,
    opts: {
      host: string;
      namespace: pulumi.Input<string>;
      serviceName: pulumi.Input<string>;
      servicePort: number;
      parent: pulumi.Resource;
    },
  ) {
    this.createIngressRoute(name, opts);
    this.registerInternal(name, this.traefikInternalIp);
  }

  publish(
    name: string,
    opts: {
      host: string;
      namespace: pulumi.Input<string>;
      serviceName: pulumi.Input<string>;
      servicePort: number;
      parent: pulumi.Resource;
    },
  ) {
    this.createIngressRoute(name, opts);
    this.registerPublic(name, this.vpsIp);
  }
}
