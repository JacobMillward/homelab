import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { RegistryTarget, buildAndPushImage } from "homelab-lib";

export interface RunnerArgs {
  namespace: pulumi.Output<string>;
  endpoint: pulumi.Output<string>;
  secret: pulumi.Output<string>;
  registry: RegistryTarget;
  dependsOn: pulumi.Resource[];
}

// Forgejo derives a runner's UUID from the first 16 bytes of its shared secret,
// so both sides can be computed from the secret alone with no registration call.
function uuidFromSecret(secret: string): string {
  const h = Buffer.from(secret.slice(0, 16), "ascii").toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function createRunner(parent: pulumi.Resource, args: RunnerArgs) {
  const childOpts = { parent };

  const image = buildAndPushImage(parent, {
    name: "forgejo-runner",
    contextDir: "images/forgejo-runner",
    registry: args.registry,
  });

  const config = pulumi
    .all([args.endpoint, args.secret])
    .apply(
      ([endpoint, secret]) => `log:
  level: info
runner:
  capacity: 1
  labels:
    - "self-hosted:host"
server:
  connections:
    homelab:
      url: ${endpoint}/
      uuid: ${uuidFromSecret(secret)}
      token: ${secret}
`,
    );

  const configSecret = new k8s.core.v1.Secret(
    "forgejo-runner-config",
    {
      metadata: { namespace: args.namespace },
      stringData: { "config.yaml": config },
    },
    childOpts,
  );

  const labels = { app: "forgejo-runner" };
  new k8s.apps.v1.Deployment(
    "forgejo-runner",
    {
      metadata: { namespace: args.namespace },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        progressDeadlineSeconds: 180,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            volumes: [
              { name: "config", secret: { secretName: configSecret.metadata.name } },
              { name: "data", emptyDir: {} },
            ],
            containers: [
              {
                name: "runner",
                image,
                command: ["forgejo-runner", "daemon", "--config", "/config/config.yaml"],
                workingDir: "/data",
                volumeMounts: [
                  { name: "config", mountPath: "/config", readOnly: true },
                  { name: "data", mountPath: "/data" },
                ],
              },
            ],
          },
        },
      },
    },
    { ...childOpts, dependsOn: args.dependsOn },
  );
}
