import * as fs from "fs";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export interface BlocklistCronJobArgs {
  namespace: string;
}

interface BlocklistSource {
  name: string;
  url: string;
  scope: "ip" | "range";
  column?: number;
}

const sources: BlocklistSource[] = [
  {
    name: "firehol-level1",
    url: "https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset",
    scope: "range",
  },
  {
    name: "ipsum-level3",
    url: "https://raw.githubusercontent.com/stamparm/ipsum/master/levels/3.txt",
    scope: "ip",
    column: 1,
  },
];

const decisionDuration = "26h";

const sourcesTsv = sources.map((s) => [s.name, s.url, s.scope, s.column ?? ""].join("\t")).join("\n") + "\n";

const scriptsDir = path.join(__dirname, "scripts");
const fetchListsScript = fs.readFileSync(path.join(scriptsDir, "fetch-lists.sh"), "utf8");
const importListsScript = fs.readFileSync(path.join(scriptsDir, "import-lists.sh"), "utf8");

export class BlocklistCronJob extends pulumi.ComponentResource {
  constructor(name: string, args: BlocklistCronJobArgs, opts?: pulumi.ComponentResourceOptions) {
    super("platform:BlocklistCronJob", name, {}, opts);
    const childOpts = { parent: this };

    const sa = new k8s.core.v1.ServiceAccount(
      "crowdsec-blocklist-importer",
      { metadata: { namespace: args.namespace } },
      childOpts,
    );

    const role = new k8s.rbac.v1.Role(
      "crowdsec-blocklist-importer",
      {
        metadata: { namespace: args.namespace },
        rules: [
          { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
          { apiGroups: [""], resources: ["pods/exec"], verbs: ["create"] },
        ],
      },
      childOpts,
    );

    new k8s.rbac.v1.RoleBinding(
      "crowdsec-blocklist-importer",
      {
        metadata: { namespace: args.namespace },
        subjects: [{ kind: "ServiceAccount", name: sa.metadata.name, namespace: args.namespace }],
        roleRef: { kind: "Role", name: role.metadata.name, apiGroup: "rbac.authorization.k8s.io" },
      },
      childOpts,
    );

    const scripts = new k8s.core.v1.ConfigMap(
      "crowdsec-blocklist-scripts",
      {
        metadata: { namespace: args.namespace },
        data: {
          "fetch-lists.sh": fetchListsScript,
          "import-lists.sh": importListsScript,
          "sources.tsv": sourcesTsv,
        },
      },
      childOpts,
    );

    new k8s.batch.v1.CronJob(
      "crowdsec-blocklist-import",
      {
        metadata: { namespace: args.namespace },
        spec: {
          schedule: "23 4 * * *",
          jobTemplate: {
            spec: {
              template: {
                spec: {
                  serviceAccountName: sa.metadata.name,
                  restartPolicy: "OnFailure",
                  initContainers: [
                    {
                      name: "fetch-lists",
                      image: "curlimages/curl:8.22.0",
                      command: ["/bin/sh", "/config/fetch-lists.sh"],
                      volumeMounts: [
                        { name: "config", mountPath: "/config" },
                        { name: "shared", mountPath: "/shared" },
                      ],
                    },
                  ],
                  containers: [
                    {
                      name: "import",
                      image: "alpine/kubectl:1.37.0",
                      command: ["/bin/sh", "/config/import-lists.sh"],
                      env: [
                        { name: "NAMESPACE", value: args.namespace },
                        { name: "DECISION_DURATION", value: decisionDuration },
                      ],
                      volumeMounts: [
                        { name: "config", mountPath: "/config" },
                        { name: "shared", mountPath: "/shared" },
                      ],
                    },
                  ],
                  volumes: [
                    { name: "config", configMap: { name: scripts.metadata.name } },
                    { name: "shared", emptyDir: {} },
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
