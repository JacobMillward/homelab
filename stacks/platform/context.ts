import * as k8s from "@pulumi/kubernetes";

export interface PlatformCtx {
  k8sProvider: k8s.Provider;
}

export function makePlatformCtx(k8sProvider: k8s.Provider): PlatformCtx {
  return { k8sProvider };
}
