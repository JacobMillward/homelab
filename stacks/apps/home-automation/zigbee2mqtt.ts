import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { DnsRegistrar } from "../dns";
import { MqttCredentials } from "./mosquitto";

interface Zigbee2mqttArgs {
  namespace: k8s.core.v1.Namespace;
  mqttUrl: pulumi.Output<string>;
  mqttCredentials: MqttCredentials;
  provider: k8s.Provider;
  storageClassName: pulumi.Output<string>;
  dns: DnsRegistrar;
}

export function deployZigbee2mqtt(args: Zigbee2mqttArgs) {
  const {
    namespace: ns,
    mqttUrl,
    mqttCredentials,
    provider,
    storageClassName,
    dns,
  } = args;

  const release = new k8s.helm.v3.Release(
    "zigbee2mqtt",
    {
      chart: "zigbee2mqtt",
      version: "2.9.1",
      namespace: ns.metadata.name,
      repositoryOpts: {
        repo: "https://charts.zigbee2mqtt.io",
      },
      values: {
        service: {
          type: "ClusterIP",
        },
        statefulset: {
          storage: {
            enabled: true,
            size: "2Gi",
            storageClassName,
          },
        },
        zigbee2mqtt: {
          serial: {
            port: "tcp://192.168.100.5:6638",
            baudrate: 115200,
            adapter: "ember",
            disable_led: false,
          },
          advanced: {
            transmit_power: 20,
          },
          mqtt: {
            server: mqttUrl,
            base_topic: "zigbee2mqtt",
            client_id: "zigbee2mqtt",
            include_device_information: true,
            user: mqttCredentials.username,
            password: mqttCredentials.password,
          },
          frontend: {
            enabled: true,
          },
          homeassistant: {
            enabled: true,
          },
        },
      },
    },
    { provider },
  );

  const svc = k8s.core.v1.Service.get(
    "zigbee2mqtt-svc",
    pulumi.interpolate`${release.status.namespace}/${release.status.name}`,
    { provider },
  );

  dns.register("z2m", svc.spec.clusterIP);
}
