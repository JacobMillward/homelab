import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface RegistryTarget {
  // Must resolve on the nodes themselves: kubelet pulls images using the node's
  // own DNS, not CoreDNS or NetBird's, so a Service hostname won't work.
  pushHost: pulumi.Input<string>;
  username: pulumi.Input<string>;
  password: pulumi.Input<string>;
  // Whatever has to exist before a push works, e.g. the DNS record behind pushHost.
  dependsOn?: pulumi.Resource[];
}

export interface BuildAndPushImageArgs {
  name: string;
  // Relative to the repo root (e.g. "images/crowdsec-firewall-bouncer"), not
  // to whatever stack directory `pulumi` happens to be invoked from.
  contextDir: string;
  registry: RegistryTarget;
}

// lib/ is always directly under the repo root, so this resolves reliably
// regardless of which stack's directory the pulumi CLI was actually run from.
const REPO_ROOT = path.resolve(__dirname, "..");

// Content-addressed tag: changed context means a new resource and a rebuild,
// unchanged means Pulumi's state skips the build entirely.
function hashContextDir(relativeDir: string): string {
  const hash = crypto.createHash("sha256");
  const absDir = path.join(REPO_ROOT, relativeDir);
  for (const f of fs.readdirSync(absDir).sort()) {
    const full = path.join(absDir, f);
    if (fs.statSync(full).isFile()) {
      hash.update(f);
      hash.update(fs.readFileSync(full));
    }
  }
  return hash.digest("hex").slice(0, 12);
}

// Builds and pushes an image, returning a digest-pinned reference. Uses buildah
// unprivileged (vfs storage, chroot isolation) since kaniko is unmaintained.
export function buildAndPushImage(
  parent: pulumi.Resource,
  args: BuildAndPushImageArgs,
): pulumi.Output<string> {
  const tag = hashContextDir(args.contextDir);

  const build = new command.local.Command(
    `${args.name}-build-push-${tag}`,
    {
      create: `
set -euo pipefail
IMAGE="\${PUSH_HOST}/${args.name}:${tag}"
# A NetBird DNS record can exist server-side before it's propagated to this
# peer's resolver, so wait for it to actually resolve before pushing.
for i in $(seq 1 30); do
  getent hosts "$PUSH_HOST" >/dev/null 2>&1 && break
  sleep 2
done
# Traefik's routing table also lags a beat behind a fresh pod becoming
# ready, so wait for the registry to actually answer before logging in.
for i in $(seq 1 30); do
  curl -sf -o /dev/null "https://\${PUSH_HOST}/v2/" && break
  sleep 2
done
buildah login -u "$REGISTRY_USER" -p "$REGISTRY_PASS" "\${PUSH_HOST}" >&2
# Pulling doubles as the does-it-already-exist check, and leaves the image in
# local storage for the push either way.
if ! buildah --storage-driver vfs pull "docker://$IMAGE" >&2; then
  buildah bud --storage-driver vfs --isolation chroot -t "$IMAGE" "${args.contextDir}" >&2
fi
buildah push --storage-driver vfs --digestfile /tmp/${args.name}-${tag}-digest "$IMAGE" "docker://$IMAGE" >&2
cat /tmp/${args.name}-${tag}-digest
`,
      dir: REPO_ROOT,
      environment: {
        PUSH_HOST: args.registry.pushHost,
        REGISTRY_USER: args.registry.username,
        REGISTRY_PASS: args.registry.password,
      },
    },
    {
      parent,
      additionalSecretOutputs: ["stdout"],
      dependsOn: args.registry.dependsOn,
      // Where the repo sits on disk isn't part of the image, and it differs
      // between a checkout, a worktree and PKO's workspace.
      ignoreChanges: ["dir"],
    },
  );

  return pulumi
    .all([args.registry.pushHost, build.stdout])
    .apply(([pushHost, digest]) => `${pushHost}/${args.name}:${tag}@${digest.trim()}`);
}
