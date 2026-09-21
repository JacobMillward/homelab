import * as pulumi from "@pulumi/pulumi";

export interface ForgejoClientArgs {
  endpoint: pulumi.Input<string>;
  adminToken: pulumi.Input<string>;
}

interface ResolvedClient {
  endpoint: string;
  adminToken: string;
}

export async function forgejoRequest<T = unknown>(
  client: ResolvedClient,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const url = `${client.endpoint.replace(/\/$/, "")}/api/v1${path}`;
  const res = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${client.adminToken}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Forgejo API ${method} ${path} failed: ${res.status} ${text}`);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

// Minting the first token is the one call that can't use a token, so it goes
// through basic auth instead (the API requires it for this route specifically).
export async function forgejoBasicRequest<T = unknown>(
  endpoint: string,
  username: string,
  password: string,
  method: string,
  path: string,
  body?: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const url = `${endpoint.replace(/\/$/, "")}/api/v1${path}`;
  const res = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Forgejo API ${method} ${path} failed: ${res.status} ${text}`);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

// NOTE: ResourceProvider.create/delete receive fully-resolved plain values,
// not Input/Output. delete() only gets create()'s outs, never the original
// inputs, so "<X>Outputs" below carries whatever delete() needs.

export interface ForgejoAdminTokenInputs {
  endpoint: pulumi.Input<string>;
  username: pulumi.Input<string>;
  password: pulumi.Input<string>;
  tokenName: pulumi.Input<string>;
}

interface ForgejoAdminTokenOutputs {
  endpoint: string;
  username: string;
  password: string;
  tokenId: number;
  token: string;
}

export const adminTokenProvider = {
  async create(
    inputs: { endpoint: string; username: string; password: string; tokenName: string },
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ id: string; outs: ForgejoAdminTokenOutputs }> {
    const created = await forgejoBasicRequest<{ id: number; sha1: string }>(
      inputs.endpoint,
      inputs.username,
      inputs.password,
      "POST",
      `/users/${inputs.username}/tokens`,
      { name: inputs.tokenName, scopes: ["all"] },
      fetchImpl,
    );
    return {
      id: String(created.id),
      outs: { ...inputs, tokenId: created.id, token: created.sha1 },
    };
  },

  async delete(
    _id: string,
    outs: ForgejoAdminTokenOutputs,
    fetchImpl: typeof fetch = fetch,
  ): Promise<void> {
    await forgejoBasicRequest(
      outs.endpoint,
      outs.username,
      outs.password,
      "DELETE",
      `/users/${outs.username}/tokens/${outs.tokenId}`,
      undefined,
      fetchImpl,
    );
  },
};

export class ForgejoAdminToken extends pulumi.dynamic.Resource {
  readonly token!: pulumi.Output<string>;

  constructor(name: string, args: ForgejoAdminTokenInputs, opts?: pulumi.CustomResourceOptions) {
    super(
      adminTokenProvider as pulumi.dynamic.ResourceProvider,
      name,
      { ...args, tokenId: undefined, token: undefined },
      { ...opts, additionalSecretOutputs: ["token", "password"] },
    );
  }
}


export interface ForgejoUserInputs {
  client: ForgejoClientArgs;
  username: string;
  email: string;
  password: pulumi.Input<string>;
  mustChangePassword?: boolean;
}

interface ForgejoUserOutputs {
  id: number;
  username: string;
  client: ResolvedClient;
}

// Exported separately from the pulumi.dynamic.Resource wrapper so the
// create/delete logic is unit-testable without a live Pulumi engine.
export const userProvider = {
  async create(
    inputs: {
      client: ResolvedClient;
      username: string;
      email: string;
      password: string;
      mustChangePassword?: boolean;
    },
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ id: string; outs: ForgejoUserOutputs }> {
    const user = await forgejoRequest<{ id: number }>(
      inputs.client,
      "POST",
      "/admin/users",
      {
        username: inputs.username,
        email: inputs.email,
        password: inputs.password,
        must_change_password: inputs.mustChangePassword ?? false,
      },
      fetchImpl,
    );
    return {
      id: String(user.id),
      outs: { id: user.id, username: inputs.username, client: inputs.client },
    };
  },
  async delete(id: string, outs: ForgejoUserOutputs, fetchImpl: typeof fetch = fetch): Promise<void> {
    await forgejoRequest(outs.client, "DELETE", `/admin/users/${outs.username}`, undefined, fetchImpl);
    void id;
  },
};

class ForgejoUserProvider
  implements pulumi.dynamic.ResourceProvider<Parameters<typeof userProvider.create>[0], ForgejoUserOutputs>
{
  async create(inputs: Parameters<typeof userProvider.create>[0]) {
    return userProvider.create(inputs);
  }

  async delete(id: string, outs: ForgejoUserOutputs) {
    return userProvider.delete(id, outs);
  }
}

export class ForgejoUser extends pulumi.dynamic.Resource {
  public readonly userId!: pulumi.Output<number>;
  public readonly username!: pulumi.Output<string>;

  constructor(name: string, args: ForgejoUserInputs, opts?: pulumi.CustomResourceOptions) {
    super(new ForgejoUserProvider(), name, { ...args, userId: undefined, username: undefined }, opts);
  }
}

export interface ForgejoAccessTokenInputs {
  client: ForgejoClientArgs;
  username: pulumi.Input<string>;
  tokenName: string;
  scopes: string[];
}

interface ForgejoAccessTokenOutputs {
  id: number;
  token: string;
  username: string;
  client: ResolvedClient;
}

export const accessTokenProvider = {
  async create(
    inputs: { client: ResolvedClient; username: string; tokenName: string; scopes: string[] },
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ id: string; outs: ForgejoAccessTokenOutputs }> {
    const token = await forgejoRequest<{ id: number; sha1: string }>(
      inputs.client,
      "POST",
      `/admin/users/${inputs.username}/tokens`,
      { name: inputs.tokenName, scopes: inputs.scopes },
      fetchImpl,
    );
    return {
      id: String(token.id),
      outs: { id: token.id, token: token.sha1, username: inputs.username, client: inputs.client },
    };
  },
  async delete(id: string, outs: ForgejoAccessTokenOutputs, fetchImpl: typeof fetch = fetch): Promise<void> {
    await forgejoRequest(
      outs.client,
      "DELETE",
      `/admin/users/${outs.username}/tokens/${id}`,
      undefined,
      fetchImpl,
    );
  },
};

class ForgejoAccessTokenProvider
  implements
    pulumi.dynamic.ResourceProvider<Parameters<typeof accessTokenProvider.create>[0], ForgejoAccessTokenOutputs>
{
  async create(inputs: Parameters<typeof accessTokenProvider.create>[0]) {
    return accessTokenProvider.create(inputs);
  }

  async delete(id: string, outs: ForgejoAccessTokenOutputs) {
    return accessTokenProvider.delete(id, outs);
  }
}

export class ForgejoAccessToken extends pulumi.dynamic.Resource {
  public readonly tokenId!: pulumi.Output<number>;
  public readonly token!: pulumi.Output<string>;

  constructor(name: string, args: ForgejoAccessTokenInputs, opts?: pulumi.CustomResourceOptions) {
    super(
      new ForgejoAccessTokenProvider(),
      name,
      { ...args, tokenId: undefined, token: undefined },
      { ...opts, additionalSecretOutputs: ["token", ...(opts?.additionalSecretOutputs ?? [])] },
    );
  }
}

export interface ForgejoDeployKeyInputs {
  client: ForgejoClientArgs;
  owner: pulumi.Input<string>;
  repo: pulumi.Input<string>;
  title: string;
  key: pulumi.Input<string>;
  readOnly: boolean;
}

interface ForgejoDeployKeyOutputs {
  id: number;
  owner: string;
  repo: string;
  client: ResolvedClient;
}

export const deployKeyProvider = {
  async create(
    inputs: {
      client: ResolvedClient;
      owner: string;
      repo: string;
      title: string;
      key: string;
      readOnly: boolean;
    },
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ id: string; outs: ForgejoDeployKeyOutputs }> {
    const deployKey = await forgejoRequest<{ id: number }>(
      inputs.client,
      "POST",
      `/repos/${inputs.owner}/${inputs.repo}/keys`,
      { title: inputs.title, key: inputs.key, read_only: inputs.readOnly },
      fetchImpl,
    );
    return {
      id: String(deployKey.id),
      outs: { id: deployKey.id, owner: inputs.owner, repo: inputs.repo, client: inputs.client },
    };
  },
  async delete(id: string, outs: ForgejoDeployKeyOutputs, fetchImpl: typeof fetch = fetch): Promise<void> {
    await forgejoRequest(
      outs.client,
      "DELETE",
      `/repos/${outs.owner}/${outs.repo}/keys/${id}`,
      undefined,
      fetchImpl,
    );
  },
};

class ForgejoDeployKeyProvider
  implements pulumi.dynamic.ResourceProvider<Parameters<typeof deployKeyProvider.create>[0], ForgejoDeployKeyOutputs>
{
  async create(inputs: Parameters<typeof deployKeyProvider.create>[0]) {
    return deployKeyProvider.create(inputs);
  }

  async delete(id: string, outs: ForgejoDeployKeyOutputs) {
    return deployKeyProvider.delete(id, outs);
  }
}

export class ForgejoDeployKey extends pulumi.dynamic.Resource {
  public readonly keyId!: pulumi.Output<number>;

  constructor(name: string, args: ForgejoDeployKeyInputs, opts?: pulumi.CustomResourceOptions) {
    super(new ForgejoDeployKeyProvider(), name, { ...args, keyId: undefined }, opts);
  }
}

export interface ForgejoRepositoryInputs {
  client: ForgejoClientArgs;
  owner: pulumi.Input<string>;
  name: string;
  cloneAddr: pulumi.Input<string>;
  authToken: pulumi.Input<string>;
  private: boolean;
}

interface ForgejoRepositoryOutputs {
  id: number;
  cloneUrl: string;
  owner: string;
  name: string;
  client: ResolvedClient;
}

export const repositoryProvider = {
  async create(
    inputs: {
      client: ResolvedClient;
      owner: string;
      name: string;
      cloneAddr: string;
      authToken: string;
      private: boolean;
    },
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ id: string; outs: ForgejoRepositoryOutputs }> {
    const repo = await forgejoRequest<{ id: number; clone_url: string }>(
      inputs.client,
      "POST",
      "/repos/migrate",
      {
        clone_addr: inputs.cloneAddr,
        repo_owner: inputs.owner,
        repo_name: inputs.name,
        auth_token: inputs.authToken,
        private: inputs.private,
      },
      fetchImpl,
    );
    return {
      id: String(repo.id),
      outs: {
        id: repo.id,
        cloneUrl: repo.clone_url,
        owner: inputs.owner,
        name: inputs.name,
        client: inputs.client,
      },
    };
  },
  async delete(id: string, outs: ForgejoRepositoryOutputs, fetchImpl: typeof fetch = fetch): Promise<void> {
    await forgejoRequest(outs.client, "DELETE", `/repos/${outs.owner}/${outs.name}`, undefined, fetchImpl);
    void id;
  },
};

class ForgejoRepositoryProvider
  implements
    pulumi.dynamic.ResourceProvider<Parameters<typeof repositoryProvider.create>[0], ForgejoRepositoryOutputs>
{
  async create(inputs: Parameters<typeof repositoryProvider.create>[0]) {
    return repositoryProvider.create(inputs);
  }

  async delete(id: string, outs: ForgejoRepositoryOutputs) {
    return repositoryProvider.delete(id, outs);
  }
}

export class ForgejoRepository extends pulumi.dynamic.Resource {
  public readonly repoId!: pulumi.Output<number>;
  public readonly cloneUrl!: pulumi.Output<string>;

  constructor(name: string, args: ForgejoRepositoryInputs, opts?: pulumi.CustomResourceOptions) {
    super(
      new ForgejoRepositoryProvider(),
      name,
      { ...args, repoId: undefined, cloneUrl: undefined },
      opts,
    );
  }
}

export interface ForgejoPushMirrorInputs {
  client: ForgejoClientArgs;
  owner: pulumi.Input<string>;
  repo: pulumi.Input<string>;
  remoteAddress: pulumi.Input<string>;
  remoteUsername: pulumi.Input<string>;
  remotePassword: pulumi.Input<string>;
  interval?: string;
}

interface ForgejoPushMirrorOutputs {
  remoteName: string;
  owner: string;
  repo: string;
  client: ResolvedClient;
}

export const pushMirrorProvider = {
  async create(
    inputs: {
      client: ResolvedClient;
      owner: string;
      repo: string;
      remoteAddress: string;
      remoteUsername: string;
      remotePassword: string;
      interval?: string;
    },
    fetchImpl: typeof fetch = fetch,
  ): Promise<{ id: string; outs: ForgejoPushMirrorOutputs }> {
    const mirror = await forgejoRequest<{ remote_name: string }>(
      inputs.client,
      "POST",
      `/repos/${inputs.owner}/${inputs.repo}/push_mirrors`,
      {
        remote_address: inputs.remoteAddress,
        remote_username: inputs.remoteUsername,
        remote_password: inputs.remotePassword,
        interval: inputs.interval ?? "8h0m0s",
        sync_on_commit: true,
      },
      fetchImpl,
    );
    return {
      id: mirror.remote_name,
      outs: { remoteName: mirror.remote_name, owner: inputs.owner, repo: inputs.repo, client: inputs.client },
    };
  },

  async delete(id: string, outs: ForgejoPushMirrorOutputs, fetchImpl: typeof fetch = fetch): Promise<void> {
    // Mirrors created before this provider recorded its client can't be removed
    // over the API; leaving them is better than failing every later apply.
    if (!outs.client) return;
    await forgejoRequest(
      outs.client,
      "DELETE",
      `/repos/${outs.owner}/${outs.repo}/push_mirrors/${outs.remoteName}`,
      undefined,
      fetchImpl,
    );
  },
};

class ForgejoPushMirrorProvider
  implements
    pulumi.dynamic.ResourceProvider<Parameters<typeof pushMirrorProvider.create>[0], ForgejoPushMirrorOutputs>
{
  async create(inputs: Parameters<typeof pushMirrorProvider.create>[0]) {
    return pushMirrorProvider.create(inputs);
  }

  async delete(id: string, outs: ForgejoPushMirrorOutputs) {
    return pushMirrorProvider.delete(id, outs);
  }
}

export class ForgejoPushMirror extends pulumi.dynamic.Resource {
  public readonly remoteName!: pulumi.Output<string>;

  constructor(name: string, args: ForgejoPushMirrorInputs, opts?: pulumi.CustomResourceOptions) {
    super(new ForgejoPushMirrorProvider(), name, { ...args, remoteName: undefined }, opts);
  }
}
