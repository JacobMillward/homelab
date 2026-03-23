import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { DnsRegistrar } from "../dns";
import { deployMosquitto } from "./mosquitto";
import { deployZigbee2mqtt } from "./zigbee2mqtt";

interface HomeAutomationArgs {
  provider: k8s.Provider;
  storageClassName: pulumi.Output<string>;
  dns: DnsRegistrar;
}

export function deployHomeAutomation(args: HomeAutomationArgs) {
  const { provider, storageClassName, dns } = args;

  const ns = new k8s.core.v1.Namespace(
    "home-automation",
    {
      metadata: {
        name: "home-automation",
        labels: {
          "pod-security.kubernetes.io/enforce": "privileged",
          "pod-security.kubernetes.io/audit": "privileged",
          "pod-security.kubernetes.io/warn": "privileged",
        },
      },
    },
    { provider },
  );

  const mqtt = deployMosquitto({
    namespace: ns,
    provider,
    storageClassName,
    clients: ["zigbee2mqtt"],
  });

  deployZigbee2mqtt({
    namespace: ns,
    mqttUrl: mqtt.url,
    mqttCredentials: mqtt.credentials["zigbee2mqtt"],
    provider,
    storageClassName,
    dns,
  });
}
