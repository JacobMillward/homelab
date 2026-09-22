import * as pulumi from "@pulumi/pulumi";
import { CoreV1Api, KubeConfig } from "@kubernetes/client-node";

// Dynamic, not Secret.get(): that runs during preview, before the Job exists.
export interface ForgejoAdminTokenInputs {
  namespace: pulumi.Input<string>;
  secretName: pulumi.Input<string>;
}

interface ResolvedInputs {
  namespace: string;
  secretName: string;
}

interface ForgejoAdminTokenOutputs extends ResolvedInputs {
  token: string;
}

async function readToken(inputs: ResolvedInputs): Promise<string> {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  const api = kc.makeApiClient(CoreV1Api);
  const secret = await api.readNamespacedSecret({
    name: inputs.secretName,
    namespace: inputs.namespace,
  });
  const encoded = secret.data?.token;
  if (!encoded) {
    throw new Error(
      `${inputs.namespace}/${inputs.secretName} has no "token" key; the bootstrap Job should have written one`,
    );
  }
  return Buffer.from(encoded, "base64").toString("utf8");
}

const adminTokenProvider: pulumi.dynamic.ResourceProvider<ResolvedInputs, ForgejoAdminTokenOutputs> = {
  async create(inputs) {
    return {
      id: `${inputs.namespace}/${inputs.secretName}`,
      outs: { ...inputs, token: await readToken(inputs) },
    };
  },

  async update(_id, _olds, news) {
    return { outs: { ...news, token: await readToken(news) } };
  },

  async delete() {},
};

export class ForgejoAdminToken extends pulumi.dynamic.Resource {
  readonly token!: pulumi.Output<string>;

  constructor(name: string, args: ForgejoAdminTokenInputs, opts?: pulumi.CustomResourceOptions) {
    super(
      adminTokenProvider as pulumi.dynamic.ResourceProvider,
      name,
      { ...args, token: undefined },
      { ...opts, additionalSecretOutputs: ["token"] },
    );
  }
}
