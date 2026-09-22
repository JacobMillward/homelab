import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import { dockerImage } from "homelab-lib";
import { OidcClientSpec } from "../authelia";
import { CONFIG_PATH, GIT_UID, configVolume, configVolumeMount, dbEnv } from "./container";

// Forgejo derives its OAuth callback path from this, so it has to match the
// redirect URI registered with Authelia exactly, case included.
export const AUTH_SOURCE_NAME = "Authelia";

export interface BootstrapJobArgs {
  namespace: pulumi.Output<string>;
  deployment: k8s.apps.v1.Deployment;
  configSecretName: pulumi.Output<string>;
  dbSecretName: pulumi.Output<string>;
  runnerSecret: pulumi.Output<string>;
  imageBuilderSecret: pulumi.Output<string>;
  domain: string;
  oidcClient: OidcClientSpec;
}

export interface BootstrapResult {
  adminPassword: pulumi.Output<string>;
  adminTokenSecretName: string;
  job: k8s.batch.v1.Job;
}

// Fixed, because the Job creates it outside Pulumi's ownership.
const ADMIN_TOKEN_SECRET = "forgejo-admin-token";

// Covers what has no API before an admin exists: the admin account, the OIDC
// auth source, the runners, and Pulumi's own token.
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

AUTH_ID=$(forgejo admin auth list | awk '$2 == "${AUTH_SOURCE_NAME}" { print $1 }')
if [ -z "$AUTH_ID" ]; then
  forgejo admin auth add-oauth --name ${AUTH_SOURCE_NAME} --provider openidConnect \\
    --key '${args.oidcClient.clientId}' --secret '${args.oidcClient.clientSecret}' \\
    --auto-discover-url https://auth.${args.domain}/.well-known/openid-configuration \\
    --scopes openid --scopes profile --scopes email
else
  forgejo admin auth update-oauth --id "$AUTH_ID" \\
    --key '${args.oidcClient.clientId}' --secret '${args.oidcClient.clientSecret}'
fi

forgejo forgejo-cli actions register --secret '${args.runnerSecret}' \\
  --name forgejo-runner --labels self-hosted
forgejo forgejo-cli actions register --secret '${args.imageBuilderSecret}' \\
  --name forgejo-runner-image-builder --labels image-builder

# Delete the Secret to rotate; forgejo won't reuse a token name.
SA=/var/run/secrets/kubernetes.io/serviceaccount
API="https://kubernetes.default.svc/api/v1/namespaces/$(cat $SA/namespace)/secrets"
kube() { curl -sS --cacert $SA/ca.crt -H "Authorization: Bearer $(cat $SA/token)" "$@"; }

if kube -f -o /dev/null "$API/${ADMIN_TOKEN_SECRET}" 2>/dev/null; then
  echo "admin token secret already present"
else
  VALUE=$(forgejo admin user generate-access-token -u jacob \\
    -t "pulumi-$(date +%s)" --scopes all --raw)
  kube -f -o /dev/null -X POST -H 'Content-Type: application/json' -d "{
    \\"apiVersion\\": \\"v1\\", \\"kind\\": \\"Secret\\",
    \\"metadata\\": {\\"name\\": \\"${ADMIN_TOKEN_SECRET}\\"},
    \\"data\\": {\\"token\\": \\"$(printf '%s' "$VALUE" | base64 -w0)\\"}
  }" "$API"
  echo "admin token secret created"
fi
`;

  const sa = new k8s.core.v1.ServiceAccount(
    "forgejo-bootstrap",
    { metadata: { namespace: args.namespace } },
    childOpts,
  );

  const role = new k8s.rbac.v1.Role(
    "forgejo-bootstrap",
    {
      metadata: { namespace: args.namespace },
      rules: [
        {
          apiGroups: [""],
          resources: ["secrets"],
          resourceNames: [ADMIN_TOKEN_SECRET],
          verbs: ["get"],
        },
        // create can't be limited by resourceName, since the object doesn't exist yet.
        { apiGroups: [""], resources: ["secrets"], verbs: ["create"] },
      ],
    },
    childOpts,
  );

  const roleBinding = new k8s.rbac.v1.RoleBinding(
    "forgejo-bootstrap",
    {
      metadata: { namespace: args.namespace },
      subjects: [{ kind: "ServiceAccount", name: sa.metadata.name, namespace: args.namespace }],
      roleRef: { kind: "Role", name: role.metadata.name, apiGroup: "rbac.authorization.k8s.io" },
    },
    childOpts,
  );

  const job = new k8s.batch.v1.Job(
    "forgejo-bootstrap",
    {
      metadata: { namespace: args.namespace },
      spec: {
        backoffLimit: 1,
        template: {
          spec: {
            restartPolicy: "Never",
            serviceAccountName: sa.metadata.name,
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
      dependsOn: [args.deployment, roleBinding],
      // Job specs are immutable, so a template change needs a fresh Job.
      replaceOnChanges: ["spec.template"],
      deleteBeforeReplace: true,
    },
  );

  return { adminPassword: adminPassword.result, adminTokenSecretName: ADMIN_TOKEN_SECRET, job };
}
