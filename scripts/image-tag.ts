// Prints an image context directory's tag, so scripts/build-images.sh pushes
// exactly the tag the Pulumi programs will look up.
import * as path from "path";
import { imageTag } from "../lib/image-tag.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/image-tag.ts <context-dir>");
  process.exit(1);
}
console.log(imageTag(path.resolve(dir)));
