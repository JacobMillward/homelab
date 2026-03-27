import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { AppCtx } from "../app";
import { deployMosquitto } from "./mosquitto";
import { deployZigbee2mqtt } from "./zigbee2mqtt";

export class HomeAutomation extends pulumi.ComponentResource {
  constructor(ctx: AppCtx) {
    super(
      "homelab:app:HomeAutomation",
      "home-automation",
      {},
      {
        providers: { kubernetes: ctx.provider },
      },
    );

    const ns = new k8s.core.v1.Namespace(
      "home-automation",
      {
        metadata: {
          labels: {
            "pod-security.kubernetes.io/enforce": "privileged",
            "pod-security.kubernetes.io/audit": "privileged",
            "pod-security.kubernetes.io/warn": "privileged",
          },
        },
      },
      { parent: this, aliases: [{ name: "namespace" }] },
    );

    const mqtt = deployMosquitto({
      namespace: ns,
      parent: this,
      storageClassName: ctx.storageClassName,
      clients: ["zigbee2mqtt"],
    });

    deployZigbee2mqtt({
      namespace: ns,
      mqttUrl: mqtt.url,
      mqttCredentials: mqtt.credentials["zigbee2mqtt"],
      parent: this,
      storageClassName: ctx.storageClassName,
      dns: ctx.dns,
    });
  }
}
