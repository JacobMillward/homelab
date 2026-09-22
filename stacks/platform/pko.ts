import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import { dockerImage, dockerImageRef } from "homelab-lib";
import { PlatformCtx } from "./context";
import {
  ForgejoAccessToken,
  ForgejoClientArgs,
  ForgejoCollaborator,
  ForgejoUser,
} from "./forgejo/api-client";

const chart = dockerImageRef("pulumiKubernetesOperator");

export interface PulumiOperatorArgs {
  operatorNamespace: k8s.core.v1.Namespace;
  forgejo: {
    endpoint: pulumi.Output<string>;
    adminApiToken: pulumi.Output<string>;
    repoOwner: string;
    repoName: string;
  };
}

export class PulumiOperator extends pulumi.ComponentResource {
  constructor(ctx: PlatformCtx, args: PulumiOperatorArgs) {
    super("platform:PulumiOperator", "pulumi-operator", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const ns = args.operatorNamespace;

    const operator = new k8s.helm.v3.Release(
      "pulumi-kubernetes-operator",
      {
        chart: `oci://${chart.image}@${chart.digest}`,
        namespace: ns.metadata.name,
      },
      { parent: this },
    );

    const workspaceSa = new k8s.core.v1.ServiceAccount(
      "pulumi-stack-workspace",
      { metadata: { name: "pulumi-stack-workspace", namespace: ns.metadata.name } },
      { parent: this },
    );

    const authDelegatorBinding = new k8s.rbac.v1.ClusterRoleBinding(
      "pulumi-stack-workspace-auth-delegator",
      {
        metadata: { name: "pulumi-stack-workspace-auth-delegator" },
        subjects: [{ kind: "ServiceAccount", name: workspaceSa.metadata.name, namespace: ns.metadata.name }],
        roleRef: { kind: "ClusterRole", name: "system:auth-delegator", apiGroup: "rbac.authorization.k8s.io" },
      },
      { parent: this },
    );

    const clusterAdminBinding = new k8s.rbac.v1.ClusterRoleBinding(
      "pulumi-stack-workspace-cluster-admin",
      {
        metadata: { name: "pulumi-stack-workspace-cluster-admin" },
        subjects: [{ kind: "ServiceAccount", name: workspaceSa.metadata.name, namespace: ns.metadata.name }],
        roleRef: { kind: "ClusterRole", name: "cluster-admin", apiGroup: "rbac.authorization.k8s.io" },
      },
      { parent: this },
    );

    const forgejoClient: ForgejoClientArgs = {
      endpoint: args.forgejo.endpoint,
      adminToken: args.forgejo.adminApiToken,
    };

    const botPassword = new random.RandomPassword(
      "pko-bot-password",
      { length: 32, special: true },
      { parent: this },
    );

    const botUser = new ForgejoUser(
      "pko-bot",
      {
        client: forgejoClient,
        username: "pko-bot",
        email: "pko-bot@localhost.local",
        fullName: "Pulumi Kubernetes Operator",
        password: botPassword.result,
        mustChangePassword: false,
      },
      { parent: this },
    );

    // PKO only ever clones, so the account gets read on the one repo and the
    // token gets the matching scope.
    new ForgejoCollaborator(
      "pko-bot-collaborator",
      {
        client: forgejoClient,
        owner: args.forgejo.repoOwner,
        repo: args.forgejo.repoName,
        collaborator: botUser.username,
        permission: "read",
      },
      { parent: this },
    );

    const botToken = new ForgejoAccessToken(
      "pko-bot-token",
      {
        client: forgejoClient,
        username: botUser.username,
        tokenName: "pko",
        scopes: ["read:repository"],
      },
      { parent: this, additionalSecretOutputs: ["token"] },
    );

    const gitCreds = new k8s.core.v1.Secret(
      "pko-git-token",
      {
        metadata: { namespace: ns.metadata.name },
        stringData: { token: botToken.token },
      },
      { parent: this },
    );

    const workspacePodSpec = (repoDir: string) => ({
      initContainers: [
        {
          name: "generate-netbird-sdk",
          image: dockerImage("pulumiCli"),
          command: ["pulumi", "install", "--no-dependencies", "--cwd", `/share/source/${repoDir}`],
          volumeMounts: [{ name: "share", mountPath: "/share" }],
        },
      ],
      containers: [],
    });

    const commonStackSpec = {
      serviceAccountName: workspaceSa.metadata.name,
      envRefs: {
        PULUMI_CONFIG_PASSPHRASE: { type: "Secret", secret: { name: "pulumi-platform-apps-creds", key: "PULUMI_CONFIG_PASSPHRASE" } },
        AWS_ACCESS_KEY_ID: { type: "Secret", secret: { name: "pulumi-platform-apps-creds", key: "AWS_ACCESS_KEY_ID" } },
        AWS_SECRET_ACCESS_KEY: { type: "Secret", secret: { name: "pulumi-platform-apps-creds", key: "AWS_SECRET_ACCESS_KEY" } },
      },
      backend: "s3://pulumi-state?endpoint=192.168.0.40:3900&disableSSL=true&s3ForcePathStyle=true&region=garage",
      projectRepo: pulumi.interpolate`${args.forgejo.endpoint}/${args.forgejo.repoOwner}/${args.forgejo.repoName}.git`,
      gitAuth: {
        accessToken: {
          type: "Secret",
          secret: { name: gitCreds.metadata.name, key: "token" },
        },
      },
      branch: "refs/heads/main",
      refresh: true,
      continueResyncOnCommitMatch: true,
      resyncFrequencySeconds: 3600,
    };

    const platformStack = new k8s.apiextensions.CustomResource(
      "platform-stack",
      {
        apiVersion: "pulumi.com/v1",
        kind: "Stack",
        metadata: { name: "homelab-platform", namespace: ns.metadata.name },
        spec: {
          ...commonStackSpec,
          stack: "homelab",
          repoDir: "stacks/platform",
          workspaceTemplate: {
            spec: {
              image: dockerImage("pulumiCli"),
              podTemplate: { spec: workspacePodSpec("stacks/apps") },
            },
          },
        },
      },
      { parent: this, dependsOn: [operator, authDelegatorBinding, clusterAdminBinding] },
    );

    new k8s.apiextensions.CustomResource(
      "apps-stack",
      {
        apiVersion: "pulumi.com/v1",
        kind: "Stack",
        metadata: { name: "homelab-apps", namespace: ns.metadata.name },
        spec: {
          ...commonStackSpec,
          stack: "homelab",
          repoDir: "stacks/apps",
          prerequisites: [{ name: "homelab-platform" }],
          workspaceTemplate: {
            spec: {
              image: dockerImage("pulumiCli"),
              podTemplate: { spec: workspacePodSpec("stacks/platform") },
            },
          },
        },
      },
      { parent: this, dependsOn: [operator, authDelegatorBinding, clusterAdminBinding, platformStack] },
    );
  }
}
