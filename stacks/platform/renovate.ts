import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import { dockerImage } from "homelab-lib";
import { PlatformCtx } from "./context";
import {
  ForgejoAccessToken,
  ForgejoActionSecret,
  ForgejoClientArgs,
  ForgejoCollaborator,
  ForgejoUser,
} from "./forgejo/api-client";

export interface RenovateArgs {
  forgejo: {
    endpoint: pulumi.Output<string>;
    adminApiToken: pulumi.Output<string>;
    repoOwner: string;
    repoName: string;
  };
  dockerhubUsername: pulumi.Input<string>;
  dockerhubToken: pulumi.Input<string>;
}

// Scopes per Renovate's forgejo platform docs: repo and issue write, user and
// organization read.
const BOT_TOKEN_SCOPES = ["write:repository", "write:issue", "read:user", "read:organization"];

export class Renovate extends pulumi.ComponentResource {
  constructor(ctx: PlatformCtx, args: RenovateArgs) {
    super("platform:Renovate", "renovate", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });
    const childOpts = { parent: this };

    const ns = new k8s.core.v1.Namespace(
      "renovate",
      { metadata: { name: "renovate" } },
      childOpts,
    );

    const forgejoClient: ForgejoClientArgs = {
      endpoint: args.forgejo.endpoint,
      adminToken: args.forgejo.adminApiToken,
    };

    const botPassword = new random.RandomPassword(
      "renovate-bot-password",
      { length: 32, special: true },
      childOpts,
    );

    const botUser = new ForgejoUser(
      "renovate-bot",
      {
        client: forgejoClient,
        username: "renovate-bot",
        email: "renovate-bot@localhost.local",
        fullName: "Renovate Bot",
        password: botPassword.result,
        mustChangePassword: false,
      },
      childOpts,
    );

    const botToken = new ForgejoAccessToken(
      "renovate-bot-token",
      {
        client: forgejoClient,
        username: botUser.username,
        tokenName: "renovate",
        scopes: BOT_TOKEN_SCOPES,
      },
      { ...childOpts, additionalSecretOutputs: ["token"] },
    );

    // The repo is private, so the bot needs explicit access to see it at all.
    new ForgejoCollaborator(
      "renovate-bot-collaborator",
      {
        client: forgejoClient,
        owner: args.forgejo.repoOwner,
        repo: args.forgejo.repoName,
        collaborator: botUser.username,
        permission: "write",
      },
      childOpts,
    );

    // Scoped to the repo rather than mounted into the runner, which would hand
    // the token to every workflow that runs there.
    new ForgejoActionSecret(
      "renovate-token-action-secret",
      {
        client: forgejoClient,
        owner: args.forgejo.repoOwner,
        repo: args.forgejo.repoName,
        secretName: "RENOVATE_TOKEN",
        data: botToken.token,
      },
      childOpts,
    );

    const hostRulesJson = pulumi
      .all([args.dockerhubUsername, args.dockerhubToken])
      .apply(([username, password]) =>
        JSON.stringify([
          { hostType: "docker", matchHost: "docker.io", username, password },
          { hostType: "docker", matchHost: "hub.docker.com", username, password },
        ]),
      );

    const creds = new k8s.core.v1.Secret(
      "renovate-creds",
      {
        metadata: { namespace: ns.metadata.name },
        stringData: {
          token: botToken.token,
          "host-rules.json": hostRulesJson,
        },
      },
      childOpts,
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
                  containers: [
                    {
                      name: "renovate",
                      image: dockerImage("renovate"),
                      securityContext: {
                        allowPrivilegeEscalation: false,
                        capabilities: { drop: ["ALL"] },
                      },
                      env: [
                        { name: "RENOVATE_PLATFORM", value: "forgejo" },
                        { name: "RENOVATE_ENDPOINT", value: pulumi.interpolate`${args.forgejo.endpoint}/api/v1` },
                        { name: "RENOVATE_AUTODISCOVER", value: "false" },
                        {
                          name: "RENOVATE_REPOSITORIES",
                          value: `${args.forgejo.repoOwner}/${args.forgejo.repoName}`,
                        },
                        { name: "RENOVATE_ONBOARDING", value: "false" },
                        {
                          name: "RENOVATE_ALLOWED_COMMANDS",
                          value: JSON.stringify(["^bash scripts/generate-netbird-sdk\\.sh$"]),
                        },
                        {
                          name: "RENOVATE_TOKEN",
                          valueFrom: { secretKeyRef: { name: creds.metadata.name, key: "token" } },
                        },
                        {
                          name: "RENOVATE_HOST_RULES",
                          valueFrom: {
                            secretKeyRef: { name: creds.metadata.name, key: "host-rules.json" },
                          },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
      childOpts,
    );
  }
}
