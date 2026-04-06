import * as pulumi from "@pulumi/pulumi";
import * as onepassword from "@1password/pulumi-onepassword";

/**
 * Returns a function that looks up a field by label from the shared
 * "Homelab" item in the "Private" 1Password vault.
 */
export function makeOpField(
  opts?: pulumi.InvokeOptions,
): (label: string) => pulumi.Output<string> {
  const opItem = onepassword.getItemOutput(
    { vault: "Private", title: "Homelab" },
    opts,
  );

  return (label: string): pulumi.Output<string> =>
    opItem.apply((item) => {
      const field = (item.sections ?? [])
        .flatMap((s) => s.fields ?? [])
        .find((f) => f.label === label);
      if (!field) throw new Error(`1Password field "${label}" not found`);
      return field.value;
    });
}
