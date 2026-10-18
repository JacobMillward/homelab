import { test } from "node:test";
import assert from "node:assert/strict";
import { ALERTS, buildAlertBody, buildWebhookBody } from "./api.ts";

const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "6h", "12h", "1d"];

test("alert ids and titles are unique", () => {
  assert.equal(new Set(ALERTS.map((a) => a.id)).size, ALERTS.length);
  assert.equal(new Set(ALERTS.map((a) => a.title)).size, ALERTS.length);
});

test("every alert has a valid interval and a positive threshold", () => {
  for (const a of ALERTS) {
    assert.ok(INTERVALS.includes(a.interval), a.id);
    assert.ok(a.threshold > 0, a.id);
  }
});

test("every alert query is windowed and returns a time bucket", () => {
  for (const a of ALERTS) {
    assert.match(a.sql, /\$__timeFilter\(/, a.id);
    assert.match(a.sql, /\$__timeInterval\(/, a.id);
  }
});

test("buildAlertBody makes an inline raw SQL alert that pages one webhook", () => {
  const def = ALERTS[0];
  const body = buildAlertBody(def, { connectionId: "c1", sourceId: "s1", webhookId: "w1" });
  assert.equal(body.source, "inline");
  assert.equal(body.name, def.title);
  assert.equal(body.note, def.note);
  assert.equal(body.threshold, def.threshold);
  assert.equal(body.thresholdType, "above");
  assert.equal(body.interval, def.interval);
  assert.deepEqual(body.channels, [{ type: "webhook", webhookId: "w1" }]);
  assert.deepEqual(body.chartConfig, {
    displayType: "line",
    configType: "sql",
    connectionId: "c1",
    sourceId: "s1",
    sqlTemplate: def.sql,
    name: def.id,
  });
});

test("buildWebhookBody publishes JSON to the ntfy topic with a link back to HyperDX", () => {
  const body = buildWebhookBody({ name: "ntfy", url: "http://ntfy", token: "tk_x", topic: "alerts" });
  assert.equal(body.service, "generic");
  assert.equal(body.url, "http://ntfy");
  assert.deepEqual(body.headers, { Authorization: "Bearer tk_x", "Content-Type": "application/json" });
  assert.match(body.body, /"topic":"alerts"/);
  assert.match(body.body, /"title":"\{\{title\}\}"/);
  assert.match(body.body, /"message":"\{\{#if \(eq status "firing"\)\}\}Tap for details/);
  assert.match(body.body, /"click":"\{\{link\}\}"/);
});
