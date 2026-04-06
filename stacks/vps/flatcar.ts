import * as pulumi from "@pulumi/pulumi";
import * as command from "@pulumi/command";

const config = new pulumi.Config();
const channel = config.get("flatcarChannel") ?? "stable";
const version = config.require("flatcarVersion");

const imageUrl =
  `https://${channel}.release.flatcar-linux.net/amd64-usr/${version}` +
  `/flatcar_production_hetzner_image.bin.bz2`;

// Upload the official Flatcar image to Hetzner as a snapshot.
// hcloud-upload-image handles the Hetzner API dance (temp server, rescue
// mode, dd to disk, snapshot, cleanup). Only re-runs when version changes.
export function getSnapshotId(
  hcloudToken: pulumi.Output<string>,
): pulumi.Output<string> {
  const upload = new command.local.Command("flatcar-image", {
    create: pulumi.interpolate`hcloud-upload-image upload \
      --image-url "${imageUrl}" \
      --architecture x86 \
      --compression bz2 \
      --labels "os=flatcar,channel=${channel},version=${version}" \
      --description "Flatcar ${channel} ${version}" \
      --location nbg1`,
    delete: pulumi.interpolate`hcloud-upload-image delete \
      --selector "os=flatcar,channel=${channel},version=${version}" 2>/dev/null || true`,
    triggers: [version],
    environment: {
      HCLOUD_TOKEN: hcloudToken,
    },
  });

  return upload.stdout.apply((out) => {
    const match = out.match(/image=(\d+)/i);
    if (!match) {
      throw new Error(
        `Could not parse snapshot ID from hcloud-upload-image output:\n${out}`,
      );
    }
    return match[1];
  });
}
