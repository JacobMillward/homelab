import { test } from "node:test";
import assert from "node:assert/strict";
import { hyperdxRequest, webhookProvider, alertProvider } from "./api.ts";

const client = { endpoint: "https://hyperdx.example.com/", apiKey: "pak" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("hyperdxRequest sends a bearer key to /api/v2 and unwraps data", async () => {
  let seen;
  const f = async (url, init) => {
    seen = { url, init };
    return json({ data: { id: "1" } });
  };
  const out = await hyperdxRequest(client, "POST", "/webhooks", { a: 1 }, f);
  assert.equal(seen.url, "https://hyperdx.example.com/api/v2/webhooks");
  assert.equal(seen.init.headers.Authorization, "Bearer pak");
  assert.deepEqual(JSON.parse(seen.init.body), { a: 1 });
  assert.deepEqual(out, { id: "1" });
});

test("hyperdxRequest throws with the response body on failure", async () => {
  const f = async () => new Response("nope", { status: 401 });
  await assert.rejects(hyperdxRequest(client, "GET", "/alerts", undefined, f), /401 nope/);
});

test("webhookProvider.create posts the webhook and keeps the id", async () => {
  const f = async (url, init) => {
    assert.ok(url.endsWith("/api/v2/webhooks"));
    assert.equal(init.method, "POST");
    const b = JSON.parse(init.body);
    assert.equal(b.headers.Authorization, "Bearer tk_x");
    return json({ data: { _id: "w1" } }, 201);
  };
  const r = await webhookProvider.create({ client, name: "ntfy", url: "http://n/alerts", token: "tk_x", topic: "alerts" }, f);
  assert.equal(r.id, "w1");
  assert.equal(r.outs.webhookId, "w1");
});

test("webhookProvider.update PUTs the new body to the same id", async () => {
  let seen;
  const f = async (url, init) => {
    seen = { url, method: init.method };
    return json({ data: { id: "w1" } });
  };
  const olds = { client, name: "ntfy", url: "http://n/alerts", token: "tk_x", webhookId: "w1" };
  const r = await webhookProvider.update("w1", olds, { client, name: "ntfy", url: "http://n/new", token: "tk_x", topic: "alerts" }, f);
  assert.equal(seen.method, "PUT");
  assert.ok(seen.url.endsWith("/api/v2/webhooks/w1"));
  assert.equal(r.outs.url, "http://n/new");
  assert.equal(r.outs.webhookId, "w1");
});

test("webhookProvider.delete DELETEs by stored id", async () => {
  let seen;
  const f = async (url, init) => {
    seen = { url, method: init.method };
    return new Response(null, { status: 204 });
  };
  await webhookProvider.delete("w1", { client, webhookId: "w1" }, f);
  assert.equal(seen.method, "DELETE");
  assert.ok(seen.url.endsWith("/api/v2/webhooks/w1"));
});

const def = { id: "a", title: "A", note: "A note.", sql: "SELECT $__timeInterval(t) FROM x WHERE $__timeFilter(t)", threshold: 1, interval: "5m" };

test("alertProvider.create resolves the connection then posts an inline alert", async () => {
  const calls = [];
  const f = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    if (url.endsWith("/connections")) return json({ data: [{ id: "c9", name: "Local ClickHouse" }] });
    const b = JSON.parse(init.body);
    assert.equal(b.chartConfig.connectionId, "c9");
    assert.equal(b.channels[0].webhookId, "w1");
    return json({ data: { id: "a1" } });
  };
  const r = await alertProvider.create({ client, def, webhookId: "w1" }, f);
  assert.deepEqual(calls, ["GET /api/v2/connections", "POST /api/v2/alerts"]);
  assert.equal(r.id, "a1");
});

test("alertProvider.create fails clearly when no connection exists", async () => {
  const f = async () => json({ data: [] });
  await assert.rejects(alertProvider.create({ client, def, webhookId: "w1" }, f), /no ClickHouse connection/);
});

test("alertProvider.update PUTs to the stored id; delete DELETEs it", async () => {
  const calls = [];
  const f = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    if (url.endsWith("/connections")) return json({ data: [{ id: "c9", name: "x" }] });
    return init.method === "DELETE" ? new Response(null, { status: 204 }) : json({ data: { id: "a1" } });
  };
  const olds = { client, def, webhookId: "w1", alertId: "a1" };
  await alertProvider.update("a1", olds, { client, def: { ...def, threshold: 2 }, webhookId: "w1" }, f);
  await alertProvider.delete("a1", olds, f);
  assert.deepEqual(calls, ["GET /api/v2/connections", "PUT /api/v2/alerts/a1", "DELETE /api/v2/alerts/a1"]);
});
