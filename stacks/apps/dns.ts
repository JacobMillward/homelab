import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as netbird from "@pulumi/netbird";

const ZONE_DOMAIN = "millward-yuan.net";

interface DnsRegistrarArgs {
  managementUrl: pulumi.Output<string>;
  pat: pulumi.Output<string>;
  dnsZoneId: pulumi.Output<string>;
  traefikInternalIp: pulumi.Output<string>;
}

export class DnsRegistrar {
  private netbirdProvider: netbird.Provider;
  private zoneId: pulumi.Output<string>;
  private traefikInternalIp: pulumi.Output<string>;

  constructor(args: DnsRegistrarArgs) {
    this.netbirdProvider = new netbird.Provider("netbird", {
      managementUrl: args.managementUrl,
      token: args.pat,
    });
    this.zoneId = args.dnsZoneId;
    this.traefikInternalIp = args.traefikInternalIp;
  }

  register(name: string, ip: pulumi.Input<string>) {
    return new netbird.DnsRecord(
      `${name}-dns`,
      {
        name: `${name}.${ZONE_DOMAIN}`,
        zoneId: this.zoneId,
        type: "A",
        content: ip,
        ttl: 300,
      },
      { provider: this.netbirdProvider },
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
    new k8s.apiextensions.CustomResource(
      `${name}-ingress`,
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "IngressRoute",
        metadata: {
          name,
          namespace: opts.namespace,
        },
        spec: {
          entryPoints: ["websecure"],
          routes: [
            {
              match: `Host(\`${opts.host}\`)`,
              kind: "Rule",
              services: [{ name: opts.serviceName, port: opts.servicePort }],
            },
          ],
          tls: {},
        },
      },
      { parent: opts.parent },
    );

    this.register(name, this.traefikInternalIp);
  }
}
