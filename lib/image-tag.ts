import * as crypto from "crypto";
import * as fs from "fs";

// Content-addressed: a changed context is a different tag, so a registry
// lookup alone says whether the current source has been built yet.
// Takes an absolute path because node runs this file directly as well
// (scripts/image-tag.ts), where __dirname isn't available.
export function imageTag(absDir: string): string {
  const hash = crypto.createHash("sha256");
  for (const f of fs.readdirSync(absDir).sort()) {
    const full = `${absDir}/${f}`;
    if (fs.statSync(full).isFile()) {
      hash.update(f);
      hash.update(fs.readFileSync(full));
    }
  }
  return hash.digest("hex").slice(0, 12);
}
