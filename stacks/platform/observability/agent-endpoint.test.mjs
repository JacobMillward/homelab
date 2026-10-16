import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_NAMESPACE, AGENT_SERVICE, AGENT_OTLP_ENDPOINT } from "./agent-endpoint.ts";

test("the privileged node collector lives outside the namespace that runs ClickHouse and HyperDX", () => {
  assert.notEqual(AGENT_NAMESPACE, "observability");
});

test("the OTLP endpoint is derived from the service and namespace", () => {
  assert.equal(AGENT_OTLP_ENDPOINT, `http://${AGENT_SERVICE}.${AGENT_NAMESPACE}.svc.cluster.local:4318`);
});
