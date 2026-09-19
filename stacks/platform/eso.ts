import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { helmChart, dockerImage } from "homelab-lib";
import { PlatformCtx } from "./context";

const chart = helmChart("externalSecrets");

export interface EsoArgs {
  onePasswordConnectCredentials: pulumi.Input<string>;
  onePasswordConnectToken: pulumi.Input<string>;
  homelabVaultId: string;
}

export class ExternalSecrets extends pulumi.ComponentResource {
  readonly secretStoreName: pulumi.Output<string>;
  readonly operatorNamespace: k8s.core.v1.Namespace;

  constructor(ctx: PlatformCtx, args: EsoArgs) {
    super("platform:ExternalSecrets", "external-secrets", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const esoNs = new k8s.core.v1.Namespace(
      "external-secrets",
      { metadata: { name: "external-secrets" } },
      { parent: this },
    );

    const eso = new k8s.helm.v3.Release(
      "external-secrets",
      {
        chart: chart.chart,
        version: chart.version,
        namespace: esoNs.metadata.name,
        repositoryOpts: { repo: chart.registryUrl },
        values: { installCRDs: true },
      },
      { parent: this },
    );

    const connectNs = new k8s.core.v1.Namespace(
      "onepassword-connect",
      { metadata: { name: "onepassword-connect" } },
      { parent: this },
    );

    const connectCreds = new k8s.core.v1.Secret(
      "onepassword-connect-credentials",
      {
        metadata: { name: "onepassword-connect-credentials", namespace: connectNs.metadata.name },
        stringData: { "1password-credentials.json": args.onePasswordConnectCredentials },
      },
      { parent: this },
    );

    const credentialsMountPath = "/home/opuser/.config";
    const sessionEnv = { name: "OP_SESSION", value: `${credentialsMountPath}/1password-credentials.json` };

    const connectTokenSecret = new k8s.core.v1.Secret(
      "onepassword-connect-token",
      {
        metadata: { name: "onepassword-connect-token", namespace: esoNs.metadata.name },
        stringData: { token: args.onePasswordConnectToken },
      },
      { parent: this },
    );

    new k8s.apps.v1.Deployment(
      "onepassword-connect",
      {
        metadata: { name: "onepassword-connect", namespace: connectNs.metadata.name },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: "onepassword-connect" } },
          template: {
            metadata: { labels: { app: "onepassword-connect" } },
            spec: {
              volumes: [
                { name: "creds", secret: { secretName: connectCreds.metadata.name } },
                { name: "data", emptyDir: {} },
              ],
              containers: [
                {
                  name: "connect-api",
                  image: dockerImage("onePasswordConnectApi"),
                  ports: [{ containerPort: 8080 }],
                  env: [sessionEnv],
                  volumeMounts: [
                    { name: "creds", mountPath: credentialsMountPath, readOnly: true },
                    { name: "data", mountPath: "/home/opuser/.op/data" },
                  ],
                },
                {
                  name: "connect-sync",
                  image: dockerImage("onePasswordConnectSync"),
                  ports: [{ containerPort: 8081 }],
                  env: [sessionEnv, { name: "OP_HTTP_PORT", value: "8081" }],
                  volumeMounts: [
                    { name: "creds", mountPath: credentialsMountPath, readOnly: true },
                    { name: "data", mountPath: "/home/opuser/.op/data" },
                  ],
                },
              ],
            },
          },
        },
      },
      { parent: this },
    );

    const connectService = new k8s.core.v1.Service(
      "onepassword-connect",
      {
        metadata: { name: "onepassword-connect", namespace: connectNs.metadata.name },
        spec: {
          selector: { app: "onepassword-connect" },
          ports: [{ port: 8080, targetPort: 8080 }],
        },
      },
      { parent: this },
    );

    const secretStore = new k8s.apiextensions.CustomResource(
      "homelab-vault-store",
      {
        apiVersion: "external-secrets.io/v1",
        kind: "ClusterSecretStore",
        metadata: { name: "homelab-vault-store" },
        spec: {
          provider: {
            onepassword: {
              connectHost: pulumi.interpolate`http://${connectService.metadata.name}.${connectNs.metadata.name}.svc:8080`,
              vaults: { [args.homelabVaultId]: 1 },
              auth: {
                secretRef: {
                  connectTokenSecretRef: {
                    name: connectTokenSecret.metadata.name,
                    namespace: esoNs.metadata.name,
                    key: "token",
                  },
                },
              },
            },
          },
        },
      },
      { parent: this, dependsOn: [eso] },
    );

    this.secretStoreName = secretStore.metadata.name.apply((n) => n ?? "homelab-vault-store");

    const operatorNs = new k8s.core.v1.Namespace(
      "pulumi-operator",
      { metadata: { name: "pulumi-operator" } },
      { parent: this },
    );

    new k8s.apiextensions.CustomResource(
      "pulumi-platform-apps-creds",
      {
        apiVersion: "external-secrets.io/v1",
        kind: "ExternalSecret",
        metadata: { name: "pulumi-platform-apps-creds", namespace: operatorNs.metadata.name },
        spec: {
          secretStoreRef: { name: this.secretStoreName, kind: "ClusterSecretStore" },
          target: { name: "pulumi-platform-apps-creds" },
          data: [
            { secretKey: "PULUMI_CONFIG_PASSPHRASE", remoteRef: { key: "Pulumi Platform-Apps Automation", property: "Pulumi Passphrase" } },
            { secretKey: "AWS_ACCESS_KEY_ID", remoteRef: { key: "Pulumi Platform-Apps Automation", property: "Garage Access Key ID" } },
            { secretKey: "AWS_SECRET_ACCESS_KEY", remoteRef: { key: "Pulumi Platform-Apps Automation", property: "Garage Secret Access Key" } },
          ],
        },
      },
      { parent: this, dependsOn: [secretStore] },
    );

    this.operatorNamespace = operatorNs;
  }
}
