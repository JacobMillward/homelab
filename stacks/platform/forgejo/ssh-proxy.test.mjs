import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSshProxyConfig, buildSpoeConfig, buildSpoaBouncerConfig } from "./ssh-proxy.ts";

test("reads the PROXY header from the VPS and re-sends it to Forgejo", () => {
  const c = buildSshProxyConfig();
  assert.match(c, /^\s+bind :2222 accept-proxy$/m);
  assert.match(c, /server forgejo 127\.0\.0\.1:2223 send-proxy$/m);
});

test("rejects banned clients after asking CrowdSec through a SPOE group", () => {
  const c = buildSshProxyConfig();
  assert.match(c, /tcp-request content send-spoe-group crowdsec crowdsec-tcp-group/);
  assert.match(c, /tcp-request content reject if \{ var\(txn\.crowdsec\.remediation\) -m str ban \}/);
  assert.ok(c.indexOf("send-spoe-group") < c.indexOf("reject if"), "ask before rejecting");
});

test("defines the unique-id the SPOE message sends", () => {
  assert.match(buildSshProxyConfig(), /^\s+unique-id-format /m);
});

test("sends the crowdsec-tcp message as a group, never as an event", () => {
  const c = buildSpoeConfig();
  assert.match(c, /groups\s+crowdsec-tcp-group/);
  assert.match(c, /spoe-group crowdsec-tcp-group\n\s+messages crowdsec-tcp/);
  assert.doesNotMatch(c, /^\s+event /m);
});

test("prefixes SPOE variables with crowdsec, which the reject rule reads", () => {
  assert.match(buildSpoeConfig(), /option\s+var-prefix\s+crowdsec$/m);
});

test("the bouncer listens on loopback only and logs to stdout", () => {
  const c = buildSpoaBouncerConfig("http://lapi:8080/", "k");
  assert.match(c, /^listen_tcp: 127\.0\.0\.1:9000$/m);
  assert.match(c, /^log_mode: stdout$/m);
  assert.match(c, /^api_key: k$/m);
});
