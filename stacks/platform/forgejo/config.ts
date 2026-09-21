import * as pulumi from "@pulumi/pulumi";

export interface ForgejoConfigArgs {
  domain: string;
  secretKey: pulumi.Output<string>;
  internalToken: pulumi.Output<string>;
  jwtSecret: pulumi.Output<string>;
  dbHost: pulumi.Output<string>;
}

// DB user/password aren't here; they come via FORGEJO__database__USER/PASSWD env vars instead.
export function buildForgejoConfig(args: ForgejoConfigArgs): pulumi.Output<string> {
  return pulumi
    .all([args.secretKey, args.internalToken, args.jwtSecret, args.dbHost])
    .apply(
      ([secretKey, internalToken, jwtSecret, dbHost]) => `
APP_NAME = Forgejo
RUN_MODE = prod

[server]
DOMAIN = git.${args.domain}
ROOT_URL = https://git.${args.domain}/
HTTP_PORT = 3000
SSH_DOMAIN = git.${args.domain}

[database]
DB_TYPE = postgres
HOST = ${dbHost}
NAME = forgejo

[security]
INSTALL_LOCK = true
SECRET_KEY = ${secretKey}
INTERNAL_TOKEN = ${internalToken}

[oauth2]
JWT_SECRET = ${jwtSecret}

[service]
DISABLE_REGISTRATION = true

[oauth2_client]
ENABLE_AUTO_REGISTRATION = true
`,
    );
}

// Config keys verified against cs-firewall-bouncer's own default template.
export function buildFirewallBouncerConfig(apiKey: pulumi.Output<string>): pulumi.Output<string> {
  return apiKey.apply((key) => `
mode: nftables
update_frequency: 10s
log_mode: stdout
log_level: info
api_url: http://crowdsec-service.crowdsec.svc.cluster.local:8080/
api_key: ${key}
disable_ipv6: false
deny_action: DROP
supported_decisions_types:
  - ban
iptables_chains:
  - INPUT
nftables:
  ipv4:
    enabled: true
    set-only: false
    table: crowdsec
    chain: crowdsec-chain
    priority: -10
  ipv6:
    enabled: true
    set-only: false
    table: crowdsec6
    chain: crowdsec6-chain
    priority: -10
nftables_hooks:
  - input
`);
}
