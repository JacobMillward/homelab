import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as onepassword from "@1password/pulumi-onepassword";

export interface PlatformCtx {
  k8sProvider: k8s.Provider;
  opField: (label: string) => pulumi.Output<string>;
}

export function makePlatformCtx(k8sProvider: k8s.Provider): PlatformCtx {
  const opItem = onepassword.getItemOutput({
    vault: "Private",
    title: "Homelab",
  });

  function opField(label: string): pulumi.Output<string> {
    return opItem.apply((item) => {
      const field = (item.sections ?? [])
        .flatMap((s) => s.fields ?? [])
        .find((f) => f.label === label);
      if (!field) throw new Error(`1Password field "${label}" not found`);
      return field.value;
    });
  }

  return { k8sProvider, opField };
}
