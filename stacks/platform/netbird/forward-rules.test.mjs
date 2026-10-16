import { test } from "node:test";
import assert from "node:assert/strict";
import { buildForwardRules } from "./forward-rules.ts";

const forwards = [
  { port: 443, dest: "10.0.0.1" },
  { port: 22, dest: "10.0.0.2" },
];

test("each forward gets a DNAT, a FORWARD accept and a MASQUERADE rule", () => {
  const { up } = buildForwardRules(forwards);
  assert.ok(up.includes("iptables -t nat -A PREROUTING -p tcp --dport 443 -j DNAT --to-destination 10.0.0.1:443"));
  assert.ok(up.includes("iptables -A FORWARD -p tcp -d 10.0.0.1 --dport 443 -j ACCEPT"));
  assert.ok(up.includes("iptables -t nat -A POSTROUTING -p tcp -d 10.0.0.1 --dport 443 -j MASQUERADE"));
  assert.ok(up.includes("--dport 22 -j DNAT --to-destination 10.0.0.2:22"));
});

test("down is up with every -A flipped to -D, with no placeholder left", () => {
  const { up, down } = buildForwardRules(forwards);
  assert.equal(down, up.replace(/ -A /g, " -D "));
  assert.ok(!up.includes("%OP%") && !down.includes("%OP%"));
});

test("a destination can be a shell expression that resolves at tunnel start", () => {
  const dest = "$(getent hosts gw.example | awk '{print $1; exit}')";
  const { up } = buildForwardRules([{ port: 4318, dest }]);
  assert.ok(up.includes(`--to-destination ${dest}:4318`));
  assert.ok(up.includes(`-d ${dest} --dport 4318`));
});
