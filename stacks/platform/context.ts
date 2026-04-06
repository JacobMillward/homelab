import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { makeOpField } from "../../lib/onepassword";

export interface PlatformCtx {
  k8sProvider: k8s.Provider;
  opField: (label: string) => pulumi.Output<string>;
}

export function makePlatformCtx(k8sProvider: k8s.Provider): PlatformCtx {
  const opField = makeOpField();
  return { k8sProvider, opField };
}
