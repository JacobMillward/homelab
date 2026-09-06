import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

export interface BlocklistCronJobArgs {
  namespace: string;
}

const fetchListsScript = `set -e
curl -sf -o /tmp/firehol.raw "https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset"
grep -v '^#' /tmp/firehol.raw | grep -v '^$' > /shared/firehol-level1.txt
curl -sf -o /tmp/ipsum.raw "https://raw.githubusercontent.com/stamparm/ipsum/master/levels/3.txt"
grep -v '^#' /tmp/ipsum.raw | awk '{print $1}' > /shared/ipsum-level3.txt
`;

function importScript(namespace: string): string {
  return `set -e
POD=$(kubectl get pods -n ${namespace} -l type=lapi -o jsonpath='{.items[0].metadata.name}')
kubectl exec -i -n ${namespace} "$POD" -- cscli decisions import -i - --format values --scope range --duration 26h --reason blocklist/firehol-level1 < /shared/firehol-level1.txt
kubectl exec -i -n ${namespace} "$POD" -- cscli decisions import -i - --format values --scope ip --duration 26h --reason blocklist/ipsum-level3 < /shared/ipsum-level3.txt
`;
}

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
                      command: ["/bin/sh", "-c", fetchListsScript],
                      volumeMounts: [{ name: "shared", mountPath: "/shared" }],
                    },
                  ],
                  containers: [
                    {
                      name: "import",
                      image: "alpine/kubectl:1.37.0",
                      command: ["/bin/sh", "-c", importScript(args.namespace)],
                      volumeMounts: [{ name: "shared", mountPath: "/shared" }],
                    },
                  ],
                  volumes: [{ name: "shared", emptyDir: {} }],
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
