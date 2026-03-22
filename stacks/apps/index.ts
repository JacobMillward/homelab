import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { deployMosquitto } from "./mosquitto";
import { deployZigbee2mqtt } from "./zigbee2mqtt";

const config = new pulumi.Config();
const talosStack = new pulumi.StackReference(config.require("talosStackRef"));
const platformStack = new pulumi.StackReference(
  config.require("platformStackRef"),
);

const kubeconfig = talosStack
  .requireOutput("kubeconfigRaw")
  .apply((v) => v as string);
const storageClassName = platformStack
  .requireOutput("storageClassName")
  .apply((v) => v as string);
const k8sProvider = new k8s.Provider("k8s-provider", { kubeconfig });

// --- Home Automation ---

const homeAutomationNs = new k8s.core.v1.Namespace(
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
  { provider: k8sProvider },
);

const mqtt = deployMosquitto({
  namespace: homeAutomationNs,
  provider: k8sProvider,
  storageClassName,
  clients: ["zigbee2mqtt"],
});
deployZigbee2mqtt({
  namespace: homeAutomationNs,
  mqttUrl: mqtt.url,
  mqttCredentials: mqtt.credentials["zigbee2mqtt"],
  provider: k8sProvider,
  storageClassName,
});
