import { test } from "node:test";
import assert from "node:assert/strict";
import { ALERTS, buildAlertBody, buildWebhookBody } from "./api.ts";

const INTERVALS = ["1m", "5m", "15m", "30m", "1h", "6h", "12h", "1d"];
const THRESHOLD_TYPES = ["above", "below", "above_exclusive", "below_or_equal", "equal", "not_equal"];

test("alert names are unique", () => {
  assert.equal(new Set(ALERTS.map((a) => a.name)).size, ALERTS.length);
});

test("every alert uses a valid interval and threshold type", () => {
  for (const a of ALERTS) {
    assert.ok(INTERVALS.includes(a.interval), a.name);
    assert.ok(THRESHOLD_TYPES.includes(a.thresholdType), a.name);
    assert.equal(typeof a.threshold, "number", a.name);
  }
});

test("every alert query is windowed and returns a time bucket first", () => {
  for (const a of ALERTS) {
    assert.match(a.sql, /\$__timeFilter\(/, a.name);
    assert.match(a.sql, /\$__timeInterval\(/, a.name);
    assert.match(a.sql, /^\s*SELECT\s+\$__timeInterval\(/i, a.name);
  }
});

test("buildAlertBody makes an inline raw SQL alert that pages one webhook", () => {
  const def = ALERTS[0];
  const body = buildAlertBody(def, { connectionId: "c1", sourceId: "s1", webhookId: "w1" });
  assert.equal(body.source, "inline");
  assert.equal(body.name, def.name);
  assert.equal(body.threshold, def.threshold);
  assert.equal(body.interval, def.interval);
  assert.equal(body.thresholdType, def.thresholdType);
  assert.deepEqual(body.channels, [{ type: "webhook", webhookId: "w1" }]);
  assert.deepEqual(body.chartConfig, {
    displayType: "line",
    configType: "sql",
    connectionId: "c1",
    sourceId: "s1",
    sqlTemplate: def.sql,
    name: def.name,
  });
});

test("buildWebhookBody is a generic webhook with a bearer header", () => {
  const body = buildWebhookBody({ name: "ntfy", url: "http://ntfy/alerts", token: "tk_x" });
  assert.equal(body.service, "generic");
  assert.equal(body.url, "http://ntfy/alerts");
  assert.deepEqual(body.headers, { Authorization: "Bearer tk_x" });
  assert.match(body.body, /\{\{/);
});
