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

const helmChartRegex =
  /chart:\s*"(?<depName>[^"]+)",\s*\n\s*version:\s*"(?<currentValue>[^"]+)"[\s\S]*?repo:\s*"(?<registryUrl>[^"]+)"/;

for (const [file, depName, currentValue, registryUrl] of [
  ["stacks/platform/longhorn.ts", "longhorn", "1.11.1", "https://charts.longhorn.io"],
  ["stacks/platform/metallb.ts", "metallb", "0.15.3", "https://metallb.github.io/metallb"],
  ["stacks/platform/postgresql.ts", "cloudnative-pg", "0.27.1", "https://cloudnative-pg.github.io/charts"],
  ["stacks/platform/traefik.ts", "traefik", "39.0.6", "https://traefik.github.io/charts"],
  ["stacks/platform/crowdsec/index.ts", "crowdsec", "0.24.2", "https://crowdsecurity.github.io/helm-charts"],
  ["stacks/apps/home-automation/zigbee2mqtt.ts", "zigbee2mqtt", "2.9.1", "https://charts.zigbee2mqtt.io"],
]) {
  test(`Helm chart pattern matches ${file}`, () => {
    const content = readFileSync(file, "utf8");
    const groups = extract(helmChartRegex, content);
    assert.equal(groups.depName, depName);
    assert.equal(groups.currentValue, currentValue);
    assert.equal(groups.registryUrl, registryUrl);
  });
}

const imageRegex = /image:\s*"(?<depName>[^":]+):(?<currentValue>[^"]+)"/;

for (const [file, depName, currentValue] of [
  ["stacks/platform/netbird/wg-peer.ts", "alpine", "3.21"],
  ["stacks/platform/crowdsec/blocklist-cronjob.ts", "curlimages/curl", "8.22.0"],
  ["stacks/apps/home-automation/mosquitto.ts", "eclipse-mosquitto", "2.0.22"],
  ["stacks/apps/joplin/index.ts", "joplin/server", "3.5.2"],
  ["stacks/platform/authelia/index.ts", "authelia/authelia", "4.38"],
  ["stacks/platform/renovate.ts", "alpine", "3.21"],
]) {
  test(`Container image pattern matches ${file}`, () => {
    const content = readFileSync(file, "utf8");
    const groups = extract(imageRegex, content);
    assert.equal(groups.depName, depName);
    assert.equal(groups.currentValue, currentValue);
  });
}

test("Container image pattern matches both images in stacks/platform/netbird/server.ts", () => {
  const content = readFileSync("stacks/platform/netbird/server.ts", "utf8");
  const global = new RegExp(imageRegex.source, "g");
  const matches = [...content.matchAll(global)].map((m) => `${m.groups.depName}:${m.groups.currentValue}`);
  assert.deepEqual(matches, ["netbirdio/netbird-server:0.67.4", "netbirdio/dashboard:v2.36.0"]);
});
