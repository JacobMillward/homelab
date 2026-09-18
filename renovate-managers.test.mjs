import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import jsonata from "jsonata";

const renovateConfig = JSON.parse(readFileSync("renovate.json", "utf8"));
const versions = JSON.parse(readFileSync("lib/version-pins.json", "utf8"));

async function extract(datasourceTemplate) {
  const manager = renovateConfig.customManagers.find(
    (m) => m.datasourceTemplate === datasourceTemplate,
  );
  assert.ok(manager, `no customManager found for datasource "${datasourceTemplate}"`);
  assert.equal(manager.customType, "jsonata");
  const result = await jsonata(manager.matchStrings[0]).evaluate(versions);
  return Array.isArray(result) ? result : [result];
}

// jsonata returns null-prototype objects, which fail strict deepEqual
// against plain object literals on prototype alone even when fields match.
const plain = (obj) => JSON.parse(JSON.stringify(obj));

test("helm customManager extracts a known chart correctly", async () => {
  const matches = await extract("helm");
  const certManager = matches.find((m) => m.depName === "cert-manager");
  assert.deepEqual(plain(certManager), {
    depName: "cert-manager",
    currentValue: "v1.20.0",
    registryUrl: "https://charts.jetstack.io",
  });
});

test("docker customManager extracts a known image correctly", async () => {
  const matches = await extract("docker");
  const authelia = matches.find((m) => m.depName === "authelia/authelia");
  assert.deepEqual(plain(authelia), { depName: "authelia/authelia", currentValue: "4.38" });
});

test("go customManager extracts the known module correctly", async () => {
  const matches = await extract("go");
  assert.deepEqual(plain(matches), [
    {
      depName: "github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin",
      currentValue: "v1.7.1",
    },
  ]);
});

test("every helm/docker/go entry in lib/version-pins.json is actually referenced by some .ts file", () => {
  const grepPattern = '(helmChart|dockerImage|goModule)\\("[a-zA-Z0-9]+"\\)';
  const output = execSync(
    `grep -rhoE '${grepPattern}' stacks/platform stacks/apps --include="*.ts" | grep -v node_modules | grep -v /sdks/`,
    { encoding: "utf8" },
  );
  const referencedKeys = new Set(
    [...output.matchAll(/"([a-zA-Z0-9]+)"/g)].map((m) => m[1]),
  );
  const definedKeys = [
    ...Object.keys(versions.helm),
    ...Object.keys(versions.docker),
    ...Object.keys(versions.go),
  ];
  for (const key of definedKeys) {
    assert.ok(
      referencedKeys.has(key),
      `lib/version-pins.json defines "${key}" but no .ts file references it`,
    );
  }
});
