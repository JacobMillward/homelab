import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildWgHandshakeScript } from "./wg-handshake.ts";

function run(handshakeEpoch) {
  const dir = mkdtempSync(join(tmpdir(), "wgtest-"));
  const bin = join(dir, "bin");
  const out = join(dir, "textfile");
  execFileSync("mkdir", ["-p", bin, out]);
  writeFileSync(join(bin, "wg"), `#!/bin/sh\nprintf 'PEERKEY\\t${handshakeEpoch}\\n'\n`);
  chmodSync(join(bin, "wg"), 0o755);
  const script = join(dir, "run.sh");
  writeFileSync(script, buildWgHandshakeScript({ textfileDir: out }));
  execFileSync("sh", [script], { env: { PATH: `${bin}:/usr/bin:/bin` } });
  return { out, files: readdirSync(out), text: readFileSync(join(out, "wg.prom"), "utf8") };
}

test("writes the handshake age in seconds as a prometheus gauge", () => {
  const now = Math.floor(Date.now() / 1000);
  const { text } = run(now - 42);
  const m = text.match(/^wg_latest_handshake_age_seconds (\d+)$/m);
  assert.ok(m, text);
  assert.ok(Math.abs(Number(m[1]) - 42) <= 2);
});

test("leaves only the final file behind (atomic write)", () => {
  const { files } = run(Math.floor(Date.now() / 1000));
  assert.deepEqual(files, ["wg.prom"]);
});

test("reports -1 when the peer has never completed a handshake", () => {
  const { text } = run(0);
  assert.match(text, /^wg_latest_handshake_age_seconds -1$/m);
});
