import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { dockerImage } from "homelab-lib";
import { PlatformCtx } from "./context";

export interface RenovateArgs {
  githubAppId: pulumi.Input<string>;
  githubAppInstallationId: pulumi.Input<string>;
  githubAppPrivateKey: pulumi.Input<string>;
  dockerhubUsername: pulumi.Input<string>;
  dockerhubToken: pulumi.Input<string>;
}

export class Renovate extends pulumi.ComponentResource {
  constructor(ctx: PlatformCtx, args: RenovateArgs) {
    super("platform:Renovate", "renovate", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const { githubAppId: appId, githubAppInstallationId: installationId, githubAppPrivateKey: privateKey } = args;

    const hostRulesJson = pulumi
      .all([args.dockerhubUsername, args.dockerhubToken])
      .apply(([username, password]) =>
        JSON.stringify([
          { hostType: "docker", matchHost: "docker.io", username, password },
          { hostType: "docker", matchHost: "hub.docker.com", username, password },
        ]),
      );

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
          "host-rules.json": hostRulesJson,
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
                  securityContext: {
                    runAsNonRoot: true,
                    seccompProfile: { type: "RuntimeDefault" },
                  },
                  volumes: [
                    { name: "app-creds", secret: { secretName: appCreds.metadata.name } },
                    { name: "shared", emptyDir: {} },
                  ],
                  initContainers: [
                    {
                      name: "github-app-token",
                      image: dockerImage("githubAppInstallationToken"),
                      command: [
                        "sh",
                        "-c",
                        'node /app/index.js "$(cat /secrets/app-id)" "$(cat /secrets/installation-id)" /secrets/private-key.pem > /shared/renovate-token',
                      ],
                      securityContext: {
                        runAsUser: 1000,
                        allowPrivilegeEscalation: false,
                        capabilities: { drop: ["ALL"] },
                      },
                      volumeMounts: [
                        { name: "app-creds", mountPath: "/secrets", readOnly: true },
                        { name: "shared", mountPath: "/shared" },
                      ],
                    },
                  ],
                  containers: [
                    {
                      name: "renovate",
                      image: dockerImage("renovate"),
                      command: [
                        "/bin/sh",
                        "-c",
                        "export RENOVATE_TOKEN=$(cat /shared/renovate-token); exec renovate",
                      ],
                      securityContext: {
                        allowPrivilegeEscalation: false,
                        capabilities: { drop: ["ALL"] },
                      },
                      env: [
                        { name: "RENOVATE_PLATFORM", value: "github" },
                        { name: "RENOVATE_AUTODISCOVER", value: "false" },
                        { name: "RENOVATE_REPOSITORIES", value: "JacobMillward/homelab" },
                        { name: "RENOVATE_ONBOARDING", value: "false" },
                        {
                          name: "RENOVATE_HOST_RULES",
                          valueFrom: {
                            secretKeyRef: {
                              name: appCreds.metadata.name,
                              key: "host-rules.json",
                            },
                          },
                        },
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
