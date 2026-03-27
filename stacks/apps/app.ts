import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { DnsRegistrar } from "./dns";

export interface AppCtx {
  provider: k8s.Provider;
  storageClassName: pulumi.Output<string>;
  dns: DnsRegistrar;
}
