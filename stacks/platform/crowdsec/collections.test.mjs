import { test } from "node:test";
import assert from "node:assert/strict";
import { collectionsEnv } from "./collections.ts";

test("COLLECTIONS is space-separated, because the image splits on whitespace and a comma makes one unknown name", () => {
  const v = collectionsEnv(["crowdsecurity/traefik", "LePresidente/gitea"]);
  assert.equal(v, "crowdsecurity/traefik LePresidente/gitea");
  assert.ok(!v.includes(","));
});

test("rejects a collection name that contains whitespace or a comma", () => {
  assert.throws(() => collectionsEnv(["a/b,c/d"]), /collection/);
  assert.throws(() => collectionsEnv(["a/b c/d"]), /collection/);
});
