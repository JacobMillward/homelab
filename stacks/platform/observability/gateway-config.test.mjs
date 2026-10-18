import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGatewayCustomConfig } from "./gateway-config.ts";

const cfg = () => JSON.parse(buildGatewayCustomConfig());

test("severity runs before HyperDX's keyword guess in the default logs pipeline", () => {
  const p = cfg().service.pipelines["logs/out-default"].processors;
  assert.ok(p.indexOf("transform/severity") < p.indexOf("transform"));
  assert.equal(p[0], "memory_limiter");
  assert.equal(p.at(-1), "batch");
});

test("sets both severity text and number for every pino level", () => {
  const { statements } = cfg().processors["transform/severity"].log_statements[0];
  for (const [level, text] of [[30, "info"], [50, "error"], [60, "fatal"]]) {
    assert.ok(statements.some((s) => s.includes(`"level\\":${level}[,}]`) && s.includes(`severity_text, "${text}"`)));
  }
  assert.equal(statements.length, 12);
});
