import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";

export interface MqttCredentials {
  username: string;
  password: pulumi.Output<string>;
}

interface MosquittoArgs<T extends readonly string[]> {
  namespace: k8s.core.v1.Namespace;
  provider: k8s.Provider;
  storageClassName: pulumi.Output<string>;
  clients: T;
}

export function deployMosquitto<const T extends readonly string[]>(
  args: MosquittoArgs<T>,
) {
  const { namespace: ns, provider, storageClassName, clients } = args;
  const credentials = {} as Record<T[number], MqttCredentials>;
  const passwordEntries: pulumi.Output<string>[] = [];

  for (const client of clients) {
    const pw = new random.RandomPassword(`mqtt-password-${client}`, {
      length: 32,
      special: false,
    });
    credentials[client as T[number]] = {
      username: client,
      password: pw.result,
    };
    passwordEntries.push(pulumi.interpolate`${client}:${pw.result}`);
  }

  const passwordFileContent = pulumi
    .all(passwordEntries)
    .apply((entries) => entries.join("\n"));

  const credentialsSecret = new k8s.core.v1.Secret(
    "mosquitto-credentials",
    {
      metadata: {
        name: "mosquitto-credentials",
        namespace: ns.metadata.name,
      },
      stringData: {
        "password_list.txt": passwordFileContent,
      },
    },
    { provider },
  );

  const config = new k8s.core.v1.ConfigMap(
    "mosquitto-config",
    {
      metadata: {
        name: "mosquitto-config",
        namespace: ns.metadata.name,
      },
      data: {
        "mosquitto.conf": [
          "persistence true",
          "persistence_location /mosquitto/data/",
          "password_file /mosquitto/auth/passwords",
          "listener 1883",
        ].join("\n"),
      },
    },
    { provider },
  );

  const pvc = new k8s.core.v1.PersistentVolumeClaim(
    "mosquitto-data",
    {
      metadata: {
        name: "mosquitto-data",
        namespace: ns.metadata.name,
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "1Gi" } },
        storageClassName,
      },
    },
    { provider },
  );

  const labels = { app: "mosquitto" };

  new k8s.apps.v1.Deployment(
    "mosquitto",
    {
      metadata: {
        name: "mosquitto",
        namespace: ns.metadata.name,
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            initContainers: [
              {
                name: "generate-passwords",
                image: "eclipse-mosquitto:2.0.22",
                command: [
                  "sh",
                  "-c",
                  [
                    "touch /mosquitto/auth/passwords && chmod 0700 /mosquitto/auth/passwords",
                    'while IFS=: read -r user pass || [ -n "$user" ]; do',
                    '  mosquitto_passwd -b /mosquitto/auth/passwords "$user" "$pass"',
                    "done < /mosquitto/credentials/password_list.txt",
                  ].join("\n"),
                ],
                volumeMounts: [
                  {
                    name: "credentials",
                    mountPath: "/mosquitto/credentials",
                    readOnly: true,
                  },
                  { name: "auth", mountPath: "/mosquitto/auth" },
                ],
              },
            ],
            containers: [
              {
                name: "mosquitto",
                image: "eclipse-mosquitto:2.0.22",
                ports: [{ containerPort: 1883 }],
                volumeMounts: [
                  { name: "config", mountPath: "/mosquitto/config" },
                  { name: "data", mountPath: "/mosquitto/data" },
                  { name: "auth", mountPath: "/mosquitto/auth" },
                ],
              },
            ],
            volumes: [
              { name: "config", configMap: { name: config.metadata.name } },
              {
                name: "data",
                persistentVolumeClaim: { claimName: pvc.metadata.name },
              },
              {
                name: "credentials",
                secret: { secretName: credentialsSecret.metadata.name },
              },
              { name: "auth", emptyDir: {} },
            ],
          },
        },
      },
    },
    { provider },
  );

  const service = new k8s.core.v1.Service(
    "mosquitto",
    {
      metadata: {
        name: "mosquitto",
        namespace: ns.metadata.name,
      },
      spec: {
        selector: labels,
        ports: [{ name: "mqtt", port: 1883, targetPort: 1883 }],
      },
    },
    { provider },
  );

  const url = service.metadata.apply(
    (m) => `mqtt://${m.name}.${m.namespace}.svc.cluster.local:1883`,
  );

  return { service, url, credentials };
}
