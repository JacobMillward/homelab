import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";
import * as path from "path";
import { imageTag } from "./image-tag";
import { TRAEFIK_IP } from "./network";

export interface RegistryTarget {
  // Must resolve on the nodes themselves: kubelet pulls images using the node's
  // own DNS, not CoreDNS or NetBird's, so a Service hostname won't work.
  pushHost: pulumi.Input<string>;
  username: pulumi.Input<string>;
  password: pulumi.Input<string>;
  // Whatever has to exist before the registry answers, e.g. the DNS record.
  dependsOn?: pulumi.Resource[];
}

export interface SelfBuiltImageArgs {
  name: string;
  // Relative to the repo root (e.g. "images/crowdsec-firewall-bouncer"), not
  // to whatever stack directory `pulumi` happens to be invoked from.
  contextDir: string;
  registry: RegistryTarget;
}

const REPO_ROOT = path.resolve(__dirname, "..");

// Resolves a self-built image to a digest-pinned reference. Building belongs to
// .forgejo/workflows/images.yml, since buildah needs SYS_ADMIN and neither this
// program's caller nor PKO's workspace should hold it.
export function selfBuiltImage(
  parent: pulumi.Resource,
  args: SelfBuiltImageArgs,
): pulumi.Output<string> {
  const tag = imageTag(path.join(REPO_ROOT, args.contextDir));

  const resolve = new command.local.Command(
    `${args.name}-resolve-${tag}`,
    {
      create: `
set -euo pipefail
ACCEPT='application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json'
# Pinning the address sidesteps DNS entirely, which otherwise resolves
# differently from a laptop (NetBird), a pod (CoreDNS) and a node (/etc/hosts).
RESOLVE="--resolve \${PUSH_HOST}:443:${TRAEFIK_IP}"

# Traefik only routes to the registry once its pod is ready, so retry the
# readiness endpoint rather than the manifest. That keeps a 404 below meaning
# "not built yet" and nothing else.
curl -sf --retry 15 --retry-delay 2 --retry-all-errors --retry-connrefused \
  $RESOLVE -o /dev/null "https://\${PUSH_HOST}/v2/"

DIGEST=$(curl -sfI -u "$REGISTRY_USER:$REGISTRY_PASS" -H "Accept: $ACCEPT" \
  $RESOLVE "https://\${PUSH_HOST}/v2/${args.name}/manifests/${tag}" \
  | tr -d '\\r' | awk -F': ' 'tolower($1) == "docker-content-digest" { print $2 }') || true

if [ -z "$DIGEST" ]; then
  echo "${args.name}:${tag} is not in the registry. Run 'just images'," >&2
  echo "or merge to main and let .forgejo/workflows/images.yml build it." >&2
  exit 1
fi
printf '%s' "$DIGEST"
`,
      environment: {
        PUSH_HOST: args.registry.pushHost,
        REGISTRY_USER: args.registry.username,
        REGISTRY_PASS: args.registry.password,
      },
    },
    { parent, dependsOn: args.registry.dependsOn },
  );

  return pulumi
    .all([args.registry.pushHost, resolve.stdout])
    .apply(([pushHost, digest]) => `${pushHost}/${args.name}:${tag}@${digest.trim()}`);
}
