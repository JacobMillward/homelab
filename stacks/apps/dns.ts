import * as pulumi from "@pulumi/pulumi";
import * as netbird from "@pulumi/netbird";

const ZONE_DOMAIN = "home.internal";

interface DnsRegistrarArgs {
  managementUrl: pulumi.Output<string>;
  pat: pulumi.Output<string>;
  dnsZoneId: pulumi.Output<string>;
}

export class DnsRegistrar {
  private provider: netbird.Provider;
  private zoneId: pulumi.Output<string>;

  constructor(args: DnsRegistrarArgs) {
    this.provider = new netbird.Provider("netbird", {
      managementUrl: args.managementUrl,
      token: args.pat,
    });
    this.zoneId = args.dnsZoneId;
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
      { provider: this.provider },
    );
  }
}
