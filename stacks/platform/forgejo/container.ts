import * as pulumi from "@pulumi/pulumi";

export const GIT_UID = 1000;

// Config is copied in, not mounted: the image rewrites it in place at startup.
export const WORK_DIR = "/data";
export const RUNTIME_CONFIG_PATH = `${WORK_DIR}/gitea/conf/app.ini`;
export const CONFIG_PATH = "/etc/forgejo/app.ini";

export const configVolumeMount = {
  name: "config",
  mountPath: CONFIG_PATH,
  subPath: "app.ini",
};

export const dataVolumeMount = { name: "data", mountPath: WORK_DIR };

export function configVolume(configSecretName: pulumi.Input<string>) {
  return { name: "config", secret: { secretName: configSecretName } };
}

export function dbEnv(dbSecretName: pulumi.Input<string>) {
  return [
    {
      name: "FORGEJO__database__USER",
      valueFrom: { secretKeyRef: { name: dbSecretName, key: "username" } },
    },
    {
      name: "FORGEJO__database__PASSWD",
      valueFrom: { secretKeyRef: { name: dbSecretName, key: "password" } },
    },
  ];
}

export const seedConfigCommand = [
  "/bin/sh",
  "-c",
  `mkdir -p $(dirname ${RUNTIME_CONFIG_PATH}) && cp ${CONFIG_PATH} ${RUNTIME_CONFIG_PATH}`,
];
