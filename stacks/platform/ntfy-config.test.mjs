import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNtfyServerConfig } from "./ntfy-config.ts";

const token = "tk_" + "a".repeat(29);
const args = {
  baseUrl: "https://ntfy.example.net",
  users: [
    { name: "phone", passwordHash: "$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234", role: "user" },
    { name: "hyperdx", passwordHash: "$2a$10$zzzzzzzzzzzzzzzzzzzzzzabcdefghijklmnopqrstuvwxyz01234", role: "user" },
  ],
  tokens: [{ user: "hyperdx", token, label: "HyperDX alerts" }],
  access: [
    { user: "phone", topic: "alerts", permission: "read-only" },
    { user: "hyperdx", topic: "alerts", permission: "write-only" },
  ],
};

test("denies anonymous access and trusts the proxy for client IPs", () => {
  const c = buildNtfyServerConfig(args);
  assert.match(c, /^auth-default-access: "deny-all"$/m);
  assert.match(c, /^behind-proxy: true$/m);
  assert.match(c, /^base-url: "https:\/\/ntfy\.example\.net"$/m);
});

test("serves metrics on their own port, off the proxied listener", () => {
  assert.match(buildNtfyServerConfig(args), /^metrics-listen-http: ":9091"$/m);
});

test("renders users with their bcrypt hash and role, never a plaintext password", () => {
  const c = buildNtfyServerConfig(args);
  assert.ok(c.includes(`"phone:${args.users[0].passwordHash}:user"`));
  assert.ok(c.includes(`"hyperdx:${args.users[1].passwordHash}:user"`));
});

test("maps access permissions to ntfy's short forms", () => {
  const c = buildNtfyServerConfig(args);
  assert.ok(c.includes('"phone:alerts:ro"'));
  assert.ok(c.includes('"hyperdx:alerts:wo"'));
});

test("renders access tokens with a label", () => {
  assert.ok(buildNtfyServerConfig(args).includes(`"hyperdx:${token}:HyperDX alerts"`));
});

test("rejects a token that ntfy would refuse", () => {
  assert.throws(
    () => buildNtfyServerConfig({ ...args, tokens: [{ user: "hyperdx", token: "tk_short", label: "x" }] }),
    /tk_/,
  );
});
