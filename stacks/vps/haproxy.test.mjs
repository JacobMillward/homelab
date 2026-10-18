import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHaproxyConfig } from "./haproxy.ts";

const cfg = () => buildHaproxyConfig({ homeTunnelIp: "10.99.0.2", metricsBind: "127.0.0.1:8404" });

test("logs every connection to stdout with the client address", () => {
  const c = cfg();
  assert.match(c, /^\s+log stdout format raw local0$/m);
  assert.match(c, /^\s+log global$/m);
  assert.match(c, /^\s+option tcplog$/m);
});

test("exposes prometheus metrics on the loopback bind only", () => {
  const c = cfg();
  assert.match(c, /frontend metrics\n\s+mode http\n\s+bind 127\.0\.0\.1:8404/);
  assert.match(c, /http-request use-service prometheus-exporter if \{ path \/metrics \}/);
});

test("sends PROXY to both backends and checks them without hammering", () => {
  const c = cfg();
  assert.match(c, /server home 10\.99\.0\.2:443 send-proxy check check-send-proxy inter 30s/);
  assert.match(c, /server home 10\.99\.0\.2:22 send-proxy check check-send-proxy inter 30s/);
});

test("keeps the passthrough frontends in TCP mode", () => {
  const c = cfg();
  assert.match(c, /^\s+mode tcp$/m);
  assert.match(c, /frontend app_publish\n\s+bind \*:443/);
  assert.match(c, /frontend forgejo_ssh\n\s+bind \*:22/);
});

test("refuses a metrics bind that is not loopback", () => {
  assert.throws(
    () => buildHaproxyConfig({ homeTunnelIp: "10.99.0.2", metricsBind: "0.0.0.0:8404" }),
    /loopback/,
  );
});

test("tcplog applies to the passthrough frontends only, not the HTTP metrics frontend", () => {
  const c = cfg();
  const metrics = c.slice(c.indexOf("frontend metrics"));
  assert.ok(!metrics.includes("tcplog"));
  assert.ok(!/^\s+log global$/m.test(c.slice(0, c.indexOf("frontend app_publish"))), "log global must not sit in defaults");
  for (const name of ["app_publish", "forgejo_ssh"]) {
    const block = c.slice(c.indexOf(`frontend ${name}`)).split("\n\n")[0];
    assert.match(block, /option tcplog/);
    assert.match(block, /log global/);
  }
});
