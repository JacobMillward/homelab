import * as pulumi from "@pulumi/pulumi";

export interface AutheliaConfigArgs {
  domain: string;
  jwtSecret: pulumi.Output<string>;
  sessionSecret: pulumi.Output<string>;
  storageEncryptionKey: pulumi.Output<string>;
  oidcHmacSecret: pulumi.Output<string>;
  oidcIssuerPrivateKey: pulumi.Output<string>;
  netbirdOidcClientId: pulumi.Output<string>;
  netbirdOidcClientSecret: pulumi.Output<string>;
}

// Pure function — no Pulumi resources, just YAML generation.
export function buildAutheliaConfig(
  args: AutheliaConfigArgs,
): pulumi.Output<string> {
  return pulumi
    .all([
      args.jwtSecret,
      args.sessionSecret,
      args.storageEncryptionKey,
      args.oidcHmacSecret,
      args.oidcIssuerPrivateKey,
      args.netbirdOidcClientId,
      args.netbirdOidcClientSecret,
    ])
    .apply(
      ([
        jwtSecret,
        sessionSecret,
        storageEncryptionKey,
        oidcHmacSecret,
        oidcIssuerPrivateKey,
        netbirdOidcClientId,
        netbirdOidcClientSecret,
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
      - client_id: "${netbirdOidcClientId}"
        client_name: "NetBird"
        client_secret: "${netbirdOidcClientSecret}"
        public: false
        authorization_policy: "one_factor"
        redirect_uris:
          - "https://netbird.${args.domain}/dashboard"
          - "https://netbird.${args.domain}/silent-callback"
        scopes:
          - "openid"
          - "profile"
          - "email"
        userinfo_signed_response_alg: "none"

jwt_secret: "${jwtSecret}"
`,
    );
}
