import * as pulumi from "@pulumi/pulumi";
import { SSH_LISTEN_PORT } from "./ssh-proxy";

export interface ForgejoConfigArgs {
  domain: string;
  secretKey: pulumi.Output<string>;
  internalToken: pulumi.Output<string>;
  jwtSecret: pulumi.Output<string>;
  dbHost: pulumi.Output<string>;
  metricsToken: pulumi.Input<string>;
}

// DB user/password aren't here; they come via FORGEJO__database__USER/PASSWD env vars instead.
export function buildForgejoConfig(args: ForgejoConfigArgs): pulumi.Output<string> {
  return pulumi
    .all([args.secretKey, args.internalToken, args.jwtSecret, args.dbHost, args.metricsToken])
    .apply(
      ([secretKey, internalToken, jwtSecret, dbHost, metricsToken]) => `
APP_NAME = Forgejo
RUN_MODE = prod

[server]
DOMAIN = git.${args.domain}
ROOT_URL = https://git.${args.domain}/
HTTP_PORT = 3000
SSH_DOMAIN = git.${args.domain}
; The rootless image has no OpenSSH; the built-in server listens unprivileged.
START_SSH_SERVER = true
BUILTIN_SSH_SERVER_USER = git
SSH_PORT = 22
; Only the sidecar HAProxy reaches this, and it re-sends the PROXY header.
SSH_LISTEN_HOST = 127.0.0.1
SSH_LISTEN_PORT = ${SSH_LISTEN_PORT}
SSH_SERVER_USE_PROXY_PROTOCOL = true
; Ed25519 and RSA 3072+ only.
SSH_MINIMUM_KEY_SIZES = ed25519:256, rsa:3071, ecdsa:-1, dsa:-1

[database]
DB_TYPE = postgres
HOST = ${dbHost}
NAME = forgejo

[security]
INSTALL_LOCK = true
LOGIN_REMEMBER_DAYS = 7
SECRET_KEY = ${secretKey}
INTERNAL_TOKEN = ${internalToken}

[metrics]
ENABLED = true
; /metrics has no public route, but the token still guards it inside the cluster.
TOKEN = ${metricsToken}

[oauth2]
JWT_SECRET = ${jwtSecret}

[session]
COOKIE_SECURE = true
SESSION_LIFE_TIME = 86400

[api]
ENABLE_SWAGGER = false

[repository]
DEFAULT_PRIVATE = private

[service]
REQUIRE_SIGNIN_VIEW = true
DEFAULT_KEEP_EMAIL_PRIVATE = true
DISABLE_REGISTRATION = true
ENABLE_INTERNAL_SIGNIN = false
ALLOW_ONLY_EXTERNAL_REGISTRATION = true
ENABLE_BASIC_AUTHENTICATION = false

[oauth2_client]
ENABLE_AUTO_REGISTRATION = true
ACCOUNT_LINKING = auto
`,
    );
}
