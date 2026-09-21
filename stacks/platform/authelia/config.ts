import * as pulumi from "@pulumi/pulumi";
import { OidcClientSpec } from "./oidc-client";

export interface AutheliaConfigArgs {
  domain: string;
  jwtSecret: pulumi.Output<string>;
  sessionSecret: pulumi.Output<string>;
  storageEncryptionKey: pulumi.Output<string>;
  oidcHmacSecret: pulumi.Output<string>;
  oidcIssuerPrivateKey: pulumi.Output<string>;
  oidcClients: OidcClientSpec[];
}

function renderOidcClient(client: {
  clientId: string;
  clientSecret: string;
  clientName: string;
  redirectUris: string[];
  scopes: string[];
  authorizationPolicy: string;
  userinfoSignedResponseAlg?: string;
}): string {
  const redirectUrisYaml = client.redirectUris
    .map((u) => `          - "${u}"`)
    .join("\n");
  const scopesYaml = client.scopes.map((s) => `          - "${s}"`).join("\n");
  return `      - client_id: "${client.clientId}"
        client_name: "${client.clientName}"
        client_secret: "${client.clientSecret}"
        public: false
        authorization_policy: "${client.authorizationPolicy}"
        redirect_uris:
${redirectUrisYaml}
        scopes:
${scopesYaml}${client.userinfoSignedResponseAlg ? `\n        userinfo_signed_response_alg: "${client.userinfoSignedResponseAlg}"` : ""}`;
}

// Pure function — no Pulumi resources, just YAML generation.
export function buildAutheliaConfig(
  args: AutheliaConfigArgs,
): pulumi.Output<string> {
  const clientOutputs = args.oidcClients.map((c) =>
    pulumi.all([c.clientId, c.clientSecret]).apply(([clientId, clientSecret]) =>
      renderOidcClient({
        clientId,
        clientSecret,
        clientName: c.clientName,
        redirectUris: c.redirectUris as string[],
        scopes: c.scopes,
        authorizationPolicy: c.authorizationPolicy,
        userinfoSignedResponseAlg: c.userinfoSignedResponseAlg,
      }),
    ),
  );

  return pulumi
    .all([
      args.jwtSecret,
      args.sessionSecret,
      args.storageEncryptionKey,
      args.oidcHmacSecret,
      args.oidcIssuerPrivateKey,
      pulumi.all(clientOutputs),
    ])
    .apply(
      ([
        jwtSecret,
        sessionSecret,
        storageEncryptionKey,
        oidcHmacSecret,
        oidcIssuerPrivateKey,
        renderedClients,
      ]) => `
theme: dark
default_2fa_method: "totp"

server:
  address: "tcp://0.0.0.0:9091"

log:
  level: "info"

totp:
  issuer: "${args.domain}"

authentication_backend:
  file:
    path: "/config/users_database.yml"
    password:
      algorithm: "argon2"

access_control:
  default_policy: "one_factor"
  rules:
    - domain: "*.${args.domain}"
      policy: "one_factor"

session:
  name: "authelia_session"
  secret: "${sessionSecret}"
  cookies:
    - domain: "${args.domain}"
      authelia_url: "https://auth.${args.domain}"

storage:
  encryption_key: "${storageEncryptionKey}"
  local:
    path: "/data/db.sqlite3"

notifier:
  filesystem:
    filename: "/data/notification.txt"

identity_providers:
  oidc:
    hmac_secret: "${oidcHmacSecret}"
    issuer_private_key: |
${oidcIssuerPrivateKey
  .split("\n")
  .map((l) => "      " + l)
  .join("\n")}
    clients:
${renderedClients.join("\n")}

jwt_secret: "${jwtSecret}"
`,
    );
}
