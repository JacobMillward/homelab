import { test } from "node:test";
import assert from "node:assert/strict";
import {
  forgejoRequest,
  forgejoBasicRequest,
  userProvider,
  accessTokenProvider,
  adminTokenProvider,
  runnerTokenProvider,
  deployKeyProvider,
  repositoryProvider,
  pushMirrorProvider,
} from "./api-client.ts";

test("forgejoRequest sends a bearer token and JSON body, returns parsed JSON", async () => {
  let capturedUrl, capturedInit;
  const fakeFetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(JSON.stringify({ id: 42 }), { status: 201 });
  };

  const result = await forgejoRequest(
    { endpoint: "https://git.example.com", adminToken: "tok123" },
    "POST",
    "/admin/users",
    { username: "renovate-bot" },
    fakeFetch,
  );

  assert.deepEqual(result, { id: 42 });
  assert.equal(capturedUrl, "https://git.example.com/api/v1/admin/users");
  assert.equal(capturedInit.method, "POST");
  assert.equal(capturedInit.headers.Authorization, "Bearer tok123");
  assert.equal(capturedInit.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(capturedInit.body), { username: "renovate-bot" });
});

test("forgejoRequest throws with response body on non-2xx status", async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ message: "user already exists" }), { status: 422 });

  await assert.rejects(
    () => forgejoRequest({ endpoint: "https://git.example.com", adminToken: "tok123" }, "POST", "/admin/users", {}, fakeFetch),
    /422.*user already exists/s,
  );
});

test("forgejoRequest handles a 204 No Content response (no body to parse)", async () => {
  const fakeFetch = async () => new Response(null, { status: 204 });
  const result = await forgejoRequest(
    { endpoint: "https://git.example.com", adminToken: "tok123" },
    "DELETE",
    "/repos/o/r/keys/5",
    undefined,
    fakeFetch,
  );
  assert.equal(result, undefined);
});

test("userProvider.create posts to /admin/users and returns the new user's id and username", async () => {
  const fakeFetch = async (url, init) => {
    assert.equal(url, "https://git.example.com/api/v1/admin/users");
    const body = JSON.parse(init.body);
    assert.equal(body.username, "renovate-bot");
    assert.equal(body.email, "renovate-bot@example.com");
    assert.equal(body.password, "hunter2hunter2");
    assert.equal(body.must_change_password, false);
    return new Response(JSON.stringify({ id: 7, login: "renovate-bot" }), { status: 201 });
  };

  const result = await userProvider.create(
    {
      client: { endpoint: "https://git.example.com", adminToken: "tok123" },
      username: "renovate-bot",
      email: "renovate-bot@example.com",
      password: "hunter2hunter2",
      mustChangePassword: false,
    },
    fakeFetch,
  );

  const client = { endpoint: "https://git.example.com", adminToken: "tok123" };
  assert.equal(result.id, "7");
  assert.deepEqual(result.outs, { id: 7, username: "renovate-bot", client });
});

test("userProvider.delete DELETEs /admin/users/{username}, using outs not id", async () => {
  const client = { endpoint: "https://git.example.com", adminToken: "tok123" };
  const fakeFetch = async (url, init) => {
    assert.equal(url, "https://git.example.com/api/v1/admin/users/renovate-bot");
    assert.equal(init.method, "DELETE");
    return new Response(null, { status: 204 });
  };
  await userProvider.delete("7", { id: 7, username: "renovate-bot", client }, fakeFetch);
});

test("accessTokenProvider.create posts to /admin/users/{username}/tokens and returns the raw token", async () => {
  const fakeFetch = async (url, init) => {
    assert.equal(url, "https://git.example.com/api/v1/admin/users/renovate-bot/tokens");
    const body = JSON.parse(init.body);
    assert.equal(body.name, "renovate");
    assert.deepEqual(body.scopes, ["write:repository", "write:issue"]);
    return new Response(
      JSON.stringify({ id: 3, name: "renovate", sha1: "raw-token-value" }),
      { status: 201 },
    );
  };

  const result = await accessTokenProvider.create(
    {
      client: { endpoint: "https://git.example.com", adminToken: "tok123" },
      username: "renovate-bot",
      tokenName: "renovate",
      scopes: ["write:repository", "write:issue"],
    },
    fakeFetch,
  );

  const client = { endpoint: "https://git.example.com", adminToken: "tok123" };
  assert.equal(result.id, "3");
  assert.deepEqual(result.outs, { id: 3, token: "raw-token-value", username: "renovate-bot", client });
});

test("accessTokenProvider.delete DELETEs /admin/users/{username}/tokens/{id}", async () => {
  const client = { endpoint: "https://git.example.com", adminToken: "tok123" };
  const fakeFetch = async (url, init) => {
    assert.equal(url, "https://git.example.com/api/v1/admin/users/renovate-bot/tokens/3");
    assert.equal(init.method, "DELETE");
    return new Response(null, { status: 204 });
  };
  await accessTokenProvider.delete(
    "3",
    { id: 3, token: "raw-token-value", username: "renovate-bot", client },
    fakeFetch,
  );
});

test("deployKeyProvider.create posts to /repos/{owner}/{repo}/keys", async () => {
  const fakeFetch = async (url, init) => {
    assert.equal(url, "https://git.example.com/api/v1/repos/jacob/homelab/keys");
    const body = JSON.parse(init.body);
    assert.equal(body.title, "pko");
    assert.equal(body.key, "ssh-ed25519 AAAA...");
    assert.equal(body.read_only, true);
    return new Response(JSON.stringify({ id: 9, title: "pko" }), { status: 201 });
  };

  const result = await deployKeyProvider.create(
    {
      client: { endpoint: "https://git.example.com", adminToken: "tok123" },
      owner: "jacob",
      repo: "homelab",
      title: "pko",
      key: "ssh-ed25519 AAAA...",
      readOnly: true,
    },
    fakeFetch,
  );

  const client = { endpoint: "https://git.example.com", adminToken: "tok123" };
  assert.equal(result.id, "9");
  assert.deepEqual(result.outs, { id: 9, owner: "jacob", repo: "homelab", client });
});

test("deployKeyProvider.delete DELETEs /repos/{owner}/{repo}/keys/{id}", async () => {
  const client = { endpoint: "https://git.example.com", adminToken: "tok123" };
  const fakeFetch = async (url, init) => {
    assert.equal(url, "https://git.example.com/api/v1/repos/jacob/homelab/keys/9");
    assert.equal(init.method, "DELETE");
    return new Response(null, { status: 204 });
  };
  await deployKeyProvider.delete("9", { id: 9, owner: "jacob", repo: "homelab", client }, fakeFetch);
});

test("repositoryProvider.create posts to /repos/migrate", async () => {
  const fakeFetch = async (url, init) => {
    assert.equal(url, "https://git.example.com/api/v1/repos/migrate");
    const body = JSON.parse(init.body);
    assert.equal(body.clone_addr, "https://github.com/JacobMillward/homelab.git");
    assert.equal(body.repo_owner, "jacob");
    assert.equal(body.repo_name, "homelab");
    assert.equal(body.auth_token, "gh-pat");
    assert.equal(body.private, true);
    return new Response(
      JSON.stringify({ id: 11, clone_url: "https://git.example.com/jacob/homelab.git" }),
      { status: 201 },
    );
  };

  const result = await repositoryProvider.create(
    {
      client: { endpoint: "https://git.example.com", adminToken: "tok123" },
      owner: "jacob",
      name: "homelab",
      cloneAddr: "https://github.com/JacobMillward/homelab.git",
      authToken: "gh-pat",
      private: true,
    },
    fakeFetch,
  );

  const client = { endpoint: "https://git.example.com", adminToken: "tok123" };
  assert.equal(result.id, "11");
  assert.deepEqual(result.outs, {
    id: 11,
    cloneUrl: "https://git.example.com/jacob/homelab.git",
    owner: "jacob",
    name: "homelab",
    client,
  });
});

test("repositoryProvider.delete DELETEs /repos/{owner}/{name}", async () => {
  const client = { endpoint: "https://git.example.com", adminToken: "tok123" };
  const fakeFetch = async (url, init) => {
    assert.equal(url, "https://git.example.com/api/v1/repos/jacob/homelab");
    assert.equal(init.method, "DELETE");
    return new Response(null, { status: 204 });
  };
  await repositoryProvider.delete(
    "11",
    { id: 11, cloneUrl: "https://git.example.com/jacob/homelab.git", owner: "jacob", name: "homelab", client },
    fakeFetch,
  );
});

test("pushMirrorProvider.create posts to /repos/{owner}/{repo}/push_mirrors", async () => {
  const fakeFetch = async (url, init) => {
    assert.equal(url, "https://git.example.com/api/v1/repos/jacob/homelab/push_mirrors");
    const body = JSON.parse(init.body);
    assert.equal(body.remote_address, "https://github.com/JacobMillward/homelab.git");
    assert.equal(body.remote_username, "JacobMillward");
    assert.equal(body.remote_password, "gh-pat");
    assert.equal(body.interval, "8h0m0s");
    return new Response(JSON.stringify({ remote_name: "push-mirror-1" }), { status: 200 });
  };

  const result = await pushMirrorProvider.create(
    {
      client: { endpoint: "https://git.example.com", adminToken: "tok123" },
      owner: "jacob",
      repo: "homelab",
      remoteAddress: "https://github.com/JacobMillward/homelab.git",
      remoteUsername: "JacobMillward",
      remotePassword: "gh-pat",
    },
    fakeFetch,
  );

  assert.equal(result.id, "push-mirror-1");
  assert.deepEqual(result.outs, { remoteName: "push-mirror-1" });
});

test("forgejoBasicRequest sends basic auth credentials", async () => {
  let capturedUrl, capturedInit;
  const fakeFetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  await forgejoBasicRequest(
    "https://git.example.com",
    "jacob",
    "hunter2",
    "POST",
    "/users/jacob/tokens",
    { name: "pulumi" },
    fakeFetch,
  );

  assert.equal(capturedUrl, "https://git.example.com/api/v1/users/jacob/tokens");
  assert.equal(
    capturedInit.headers.Authorization,
    `Basic ${Buffer.from("jacob:hunter2").toString("base64")}`,
  );
});

test("adminTokenProvider.create mints a token over basic auth", async () => {
  let capturedUrl, capturedInit;
  const fakeFetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(JSON.stringify({ id: 7, sha1: "abc123" }), { status: 201 });
  };

  const result = await adminTokenProvider.create(
    {
      endpoint: "https://git.example.com",
      username: "jacob",
      password: "hunter2",
      tokenName: "pulumi",
    },
    fakeFetch,
  );

  assert.equal(capturedUrl, "https://git.example.com/api/v1/users/jacob/tokens");
  assert.deepEqual(JSON.parse(capturedInit.body), { name: "pulumi", scopes: ["all"] });
  assert.equal(result.id, "7");
  assert.equal(result.outs.token, "abc123");
  assert.equal(result.outs.tokenId, 7);
});

test("adminTokenProvider.delete removes the token it created", async () => {
  let capturedUrl, capturedMethod;
  const fakeFetch = async (url, init) => {
    capturedUrl = url;
    capturedMethod = init.method;
    return new Response(null, { status: 204 });
  };

  await adminTokenProvider.delete(
    "7",
    {
      endpoint: "https://git.example.com",
      username: "jacob",
      password: "hunter2",
      tokenId: 7,
      token: "abc123",
    },
    fakeFetch,
  );

  assert.equal(capturedUrl, "https://git.example.com/api/v1/users/jacob/tokens/7");
  assert.equal(capturedMethod, "DELETE");
});

test("runnerTokenProvider.create reads the admin registration token", async () => {
  let capturedUrl;
  const fakeFetch = async (url) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ token: "runner-tok" }), { status: 200 });
  };

  const result = await runnerTokenProvider.create(
    { client: { endpoint: "https://git.example.com", adminToken: "tok123" } },
    fakeFetch,
  );

  assert.equal(capturedUrl, "https://git.example.com/api/v1/admin/runners/registration-token");
  assert.equal(result.outs.token, "runner-tok");
});
