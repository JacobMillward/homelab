import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
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
  // Unscoped PAT, only to lift github.com's anonymous API rate limit.
  githubComToken: pulumi.Input<string>;
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

    new ForgejoActionSecret(
      "github-com-token-action-secret",
      {
        client: forgejoClient,
        owner: args.forgejo.repoOwner,
        repo: args.forgejo.repoName,
        // Forgejo reserves the GITHUB_ prefix for its own Actions secrets.
        secretName: "RENOVATE_GITHUB_COM_TOKEN",
        data: args.githubComToken,
      },
      childOpts,
    );

    // Docker Hub credentials, so the docker datasource isn't rate limited.
    const hostRulesJson = pulumi
      .all([args.dockerhubUsername, args.dockerhubToken])
      .apply(([username, password]) =>
        JSON.stringify([
          { hostType: "docker", matchHost: "docker.io", username, password },
          { hostType: "docker", matchHost: "hub.docker.com", username, password },
        ]),
      );

    new ForgejoActionSecret(
      "renovate-host-rules-action-secret",
      {
        client: forgejoClient,
        owner: args.forgejo.repoOwner,
        repo: args.forgejo.repoName,
        secretName: "RENOVATE_HOST_RULES",
        data: hostRulesJson,
      },
      childOpts,
    );
  }
}
