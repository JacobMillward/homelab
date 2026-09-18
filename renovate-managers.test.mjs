// renovate-managers.test.mjs
//
// Spot-checks that the JSONata queries in renovate.json's customManagers
// correctly extract dependencies from lib/version-pins.json — catching a wrong
// field name or a query that iterates the wrong object, which
// renovate-config-validator's schema check doesn't catch. Expected values
// are hardcoded (not re-derived from versions.json) so a query bug can't
// hide behind a matching self-referential assumption.
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

// jsonata's evaluate() returns null-prototype objects, which fail strict
// deepEqual against plain object literals purely on prototype identity
// even when every field matches — normalize before comparing.
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
  // Independent of the JSONata queries above: catches a versions.json entry
  // nobody's code actually consumes (dead config) or a helmChart()/
  // dockerImage()/goModule() call site with a typo'd key that doesn't
  // match anything (those functions already throw at Pulumi runtime for a
  // missing key — this is the complementary "extra, unused key" check
  // runtime can't catch).
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
