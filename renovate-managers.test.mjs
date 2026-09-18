// renovate-managers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Mirrors the three distinct patterns this repo uses for embedding a
// dependency version in TypeScript: Helm chart+version+repo, a raw
// container image "name:tag" string, and a Go-module plugin
// moduleName+version pair. Each customManager entry in renovate.json has a
// matching case here, keyed by the same regex used in that entry.

function extract(regex, content) {
  const match = regex.exec(content);
  assert.ok(match, `regex did not match:\n${regex}`);
  return match.groups;
}

test("Helm chart pattern matches stacks/platform/cert-manager.ts", () => {
  const content = readFileSync("stacks/platform/cert-manager.ts", "utf8");
  const regex =
    /chart:\s*"(?<depName>[^"]+)",\s*\n\s*version:\s*"(?<currentValue>[^"]+)"[\s\S]*?repo:\s*"(?<registryUrl>[^"]+)"/;
  const groups = extract(regex, content);
  assert.equal(groups.depName, "cert-manager");
  assert.equal(groups.currentValue, "v1.20.0");
  assert.equal(groups.registryUrl, "https://charts.jetstack.io");
});

test("Container image pattern matches stacks/platform/netbird/router.ts", () => {
  const content = readFileSync("stacks/platform/netbird/router.ts", "utf8");
  const regex = /image:\s*"(?<depName>[^":]+):(?<currentValue>[^"]+)"/;
  const groups = extract(regex, content);
  assert.equal(groups.depName, "netbirdio/netbird");
  assert.equal(groups.currentValue, "0.67.4");
});

test("Go-module plugin pattern matches stacks/platform/traefik.ts", () => {
  const content = readFileSync("stacks/platform/traefik.ts", "utf8");
  const regex =
    /moduleName:\s*"(?<depName>[^"]+)",\s*\n\s*version:\s*"(?<currentValue>[^"]+)"/;
  const groups = extract(regex, content);
  assert.equal(groups.depName, "github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin");
  assert.equal(groups.currentValue, "v1.7.1");
});
