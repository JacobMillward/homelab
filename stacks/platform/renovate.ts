import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { PlatformCtx } from "./context";

const GITHUB_APP_TOKEN_SCRIPT = `
set -eu
apk add --no-cache openssl curl >/dev/null

APP_ID=$(cat /secrets/app-id)
INSTALLATION_ID=$(cat /secrets/installation-id)

NOW=$(date +%s)
IAT=$((NOW - 60))
EXP=$((NOW + 540))

b64() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

HEADER=$(printf '{"alg":"RS256","typ":"JWT"}' | b64)
PAYLOAD=$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$IAT" "$EXP" "$APP_ID" | b64)
SIGNATURE=$(printf '%s.%s' "$HEADER" "$PAYLOAD" | openssl dgst -sha256 -sign /secrets/private-key.pem | b64)
JWT="$HEADER.$PAYLOAD.$SIGNATURE"

TOKEN=$(curl -sf -X POST \\
  -H "Authorization: Bearer $JWT" \\
  -H "Accept: application/vnd.github+json" \\
  "https://api.github.com/app/installations/$INSTALLATION_ID/access_tokens" \\
  | grep -o '"token"[^,]*' | sed 's/.*: *"\\(.*\\)"/\\1/')

if [ -z "$TOKEN" ]; then
  echo "Failed to obtain GitHub App installation token" >&2
  exit 1
fi

printf '%s' "$TOKEN" > /shared/renovate-token
`;

export interface RenovateArgs {
  githubAppId: pulumi.Input<string>;
  githubAppInstallationId: pulumi.Input<string>;
  githubAppPrivateKey: pulumi.Input<string>;
}

export class Renovate extends pulumi.ComponentResource {
  constructor(ctx: PlatformCtx, args: RenovateArgs) {
    super("platform:Renovate", "renovate", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const { githubAppId: appId, githubAppInstallationId: installationId, githubAppPrivateKey: privateKey } = args;

    const ns = new k8s.core.v1.Namespace(
      "renovate",
      { metadata: { name: "renovate" } },
      { parent: this },
    );

    const appCreds = new k8s.core.v1.Secret(
      "renovate-github-app",
      {
        metadata: { name: "renovate-github-app", namespace: ns.metadata.name },
        stringData: {
          "app-id": appId,
          "installation-id": installationId,
          "private-key.pem": privateKey,
        },
      },
      { parent: this },
    );

    new k8s.batch.v1.CronJob(
      "renovate",
      {
        metadata: { name: "renovate", namespace: ns.metadata.name },
        spec: {
          schedule: "0 6 * * *",
          concurrencyPolicy: "Forbid",
          jobTemplate: {
            spec: {
              backoffLimit: 1,
              template: {
                spec: {
                  restartPolicy: "Never",
                  volumes: [
                    { name: "app-creds", secret: { secretName: appCreds.metadata.name } },
                    { name: "shared", emptyDir: {} },
                  ],
                  initContainers: [
                    {
                      name: "github-app-token",
                      image: "alpine:3.21",
                      command: ["/bin/sh", "-c", GITHUB_APP_TOKEN_SCRIPT],
                      volumeMounts: [
                        { name: "app-creds", mountPath: "/secrets", readOnly: true },
                        { name: "shared", mountPath: "/shared" },
                      ],
                    },
                  ],
                  containers: [
                    {
                      name: "renovate",
                      image: "renovate/renovate:44.101.2",
                      command: [
                        "/bin/sh",
                        "-c",
                        "export RENOVATE_TOKEN=$(cat /shared/renovate-token); exec renovate",
                      ],
                      env: [
                        { name: "RENOVATE_PLATFORM", value: "github" },
                        { name: "RENOVATE_AUTODISCOVER", value: "false" },
                        { name: "RENOVATE_REPOSITORIES", value: "JacobMillward/homelab" },
                        // Renovate expects renovate.json to already exist at
                        // the repo root (Task 3) — no onboarding PR needed.
                        { name: "RENOVATE_ONBOARDING", value: "false" },
                      ],
                      volumeMounts: [{ name: "shared", mountPath: "/shared" }],
                    },
                  ],
                },
              },
            },
          },
        },
      },
      { parent: this },
    );
  }
}
