import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import { dockerImage } from "homelab-lib";
import { OidcClientSpec } from "../authelia";
import { CONFIG_PATH, GIT_UID, configVolume, configVolumeMount, dbEnv } from "./container";

export interface BootstrapJobArgs {
  namespace: pulumi.Output<string>;
  deployment: k8s.apps.v1.Deployment;
  configSecretName: pulumi.Output<string>;
  dbSecretName: pulumi.Output<string>;
  domain: string;
  oidcClient: OidcClientSpec;
}

export interface BootstrapResult {
  adminPassword: pulumi.Output<string>;
  job: k8s.batch.v1.Job;
}

// Covers only what has no API before an admin exists: the admin account itself and
// the OIDC auth source. Tokens are minted over the API from the password below.
export function createBootstrapJob(
  parent: pulumi.Resource,
  args: BootstrapJobArgs,
): BootstrapResult {
  const childOpts = { parent };

  const adminPassword = new random.RandomPassword(
    "forgejo-admin-password",
    { length: 32, special: true },
    childOpts,
  );

  // Flags verified against forgejo v16.0.5 source: --scopes is repeatable, not
  // comma-joined; update-oauth takes a numeric --id. A custom command skips the
  // entrypoint, so environment-to-ini has to be run by hand to apply FORGEJO__* vars.
  // The list commands pad with spaces via tabwriter, so split on whitespace.
  const bootstrapScript = pulumi.interpolate`
set -euo pipefail
environment-to-ini -c ${CONFIG_PATH} -o /tmp/app.ini
forgejo() { command forgejo --config /tmp/app.ini "$@"; }

forgejo admin user create --username jacob --password '${adminPassword.result}' --email jacob@${args.domain} --admin --must-change-password=false \\
  || forgejo admin user change-password --username jacob --password '${adminPassword.result}' --must-change-password=false

AUTH_ID=$(forgejo admin auth list | awk '$2 == "Authelia" { print $1 }')
if [ -z "$AUTH_ID" ]; then
  forgejo admin auth add-oauth --name Authelia --provider openidConnect \\
    --key '${args.oidcClient.clientId}' --secret '${args.oidcClient.clientSecret}' \\
    --auto-discover-url https://auth.${args.domain}/.well-known/openid-configuration \\
    --scopes openid --scopes profile --scopes email
else
  forgejo admin auth update-oauth --id "$AUTH_ID" \\
    --key '${args.oidcClient.clientId}' --secret '${args.oidcClient.clientSecret}'
fi
`;

  const job = new k8s.batch.v1.Job(
    "forgejo-bootstrap",
    {
      metadata: { namespace: args.namespace },
      spec: {
        backoffLimit: 1,
        template: {
          spec: {
            restartPolicy: "Never",
            // The CLI refuses to run as root, which is what the image defaults to.
            securityContext: { runAsUser: GIT_UID, runAsGroup: GIT_UID, fsGroup: GIT_UID },
            volumes: [configVolume(args.configSecretName)],
            containers: [
              {
                name: "forgejo-cli",
                image: dockerImage("forgejo"),
                command: ["/bin/sh", "-c", bootstrapScript],
                // Only the database is needed here, so keep the derived data paths
                // off the PVC the server holds.
                env: [...dbEnv(args.dbSecretName), { name: "GITEA_WORK_DIR", value: "/tmp/forgejo" }],
                volumeMounts: [configVolumeMount],
              },
            ],
          },
        },
      },
    },
    {
      ...childOpts,
      dependsOn: [args.deployment],
      // Job specs are immutable, so a template change needs a fresh Job.
      replaceOnChanges: ["spec.template"],
      deleteBeforeReplace: true,
    },
  );

  return { adminPassword: adminPassword.result, job };
}
