import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { DOMAIN, TRAEFIK_IP, RegistryTarget, selfBuiltImage } from "homelab-lib";

export interface RunnerArgs {
  namespace: pulumi.Output<string>;
  endpoint: pulumi.Output<string>;
  secret: pulumi.Output<string>;
  imageBuilderSecret: pulumi.Output<string>;
  registry: RegistryTarget;
  dependsOn: pulumi.Resource[];
}

// Forgejo derives a runner's UUID from the first 16 bytes of its shared secret,
// so both sides can be computed from the secret alone with no registration call.
function uuidFromSecret(secret: string): string {
  const h = Buffer.from(secret.slice(0, 16), "ascii").toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// buildah has to be real root with SYS_ADMIN, because Talos leaves
// user.max_user_namespaces at 0 and the default seccomp profile then refuses
// CLONE_NEWUSER. Keeping that on its own runner means workflows that only need
// a toolchain, like typecheck on Renovate branches, never run with it.
const IMAGE_BUILDER_SECURITY_CONTEXT = {
  runAsUser: 0,
  allowPrivilegeEscalation: false,
  seccompProfile: { type: "RuntimeDefault" },
  capabilities: { add: ["SYS_ADMIN", "SYS_RESOURCE"] },
};

export function createRunner(parent: pulumi.Resource, args: RunnerArgs) {
  const childOpts = { parent };

  const image = selfBuiltImage(parent, {
    name: "forgejo-runner",
    contextDir: "images/forgejo-runner",
    registry: args.registry,
  });

  const deployRunner = (
    name: string,
    label: string,
    secret: pulumi.Output<string>,
    securityContext?: object,
  ) => {
    const config = pulumi.all([args.endpoint, secret]).apply(
      ([endpoint, s]) => `log:
  level: info
runner:
  capacity: 1
  labels:
    - "${label}:host"
server:
  connections:
    homelab:
      url: ${endpoint}/
      uuid: ${uuidFromSecret(s)}
      token: ${s}
`,
    );

    const configSecret = new k8s.core.v1.Secret(
      `${name}-config`,
      {
        metadata: { namespace: args.namespace },
        stringData: { "config.yaml": config },
      },
      childOpts,
    );

    const labels = { app: name };
    new k8s.apps.v1.Deployment(
      name,
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
              // Pods resolve through CoreDNS, which never sees the node's
              // /etc/hosts, so the talos entry for the registry misses here.
              hostAliases: [{ ip: TRAEFIK_IP, hostnames: [`registry.internal.${DOMAIN}`] }],
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
                  securityContext,
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
  };

  deployRunner("forgejo-runner", "self-hosted", args.secret);
  deployRunner(
    "forgejo-runner-image-builder",
    "image-builder",
    args.imageBuilderSecret,
    IMAGE_BUILDER_SECURITY_CONTEXT,
  );
}
