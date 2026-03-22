import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";

const domain = "netbird.millward-yuan.net";

interface ServerArgs {
  provider: k8s.Provider;
  storageClassName: string;
}

export function deployServer(args: ServerArgs) {
  const { provider, storageClassName } = args;
  const config = new pulumi.Config();
  const stunIp = config.require("netbirdStunIp");

  const ns = new k8s.core.v1.Namespace(
    "netbird",
    {
      metadata: {
        name: "netbird",
        labels: {
          "pod-security.kubernetes.io/enforce": "privileged",
          "pod-security.kubernetes.io/audit": "privileged",
          "pod-security.kubernetes.io/warn": "privileged",
        },
      },
    },
    { provider },
  );

  const relayAuthSecret = new random.RandomPassword("netbird-relay-secret", {
    length: 32,
    special: false,
  });

  // NetBird base64-decodes the encryption key, so we need 44 chars (32 bytes encoded)
  const encryptionKey = new random.RandomBytes("netbird-encryption-key", {
    length: 32,
  });

  // config.yaml - matches combined/config.yaml.example from the netbird repo
  const configYaml = pulumi
    .all([relayAuthSecret.result, encryptionKey.base64])
    .apply(
      ([relaySecret, encKey]) => `server:
  listenAddress: ":80"
  exposedAddress: "https://${domain}:443"
  stunPorts:
    - 3478
  metricsPort: 9090
  healthcheckAddress: ":9000"
  logLevel: "info"
  logFile: "console"
  authSecret: "${relaySecret}"
  dataDir: "/var/lib/netbird"
  auth:
    issuer: "https://${domain}/oauth2"
    signKeyRefreshEnabled: true
    dashboardRedirectURIs:
      - "https://${domain}/nb-auth"
      - "https://${domain}/nb-silent-auth"
    cliRedirectURIs:
      - "http://localhost:53000/"
  store:
    engine: "sqlite"
    encryptionKey: "${encKey}"
`,
    );

  const configMap = new k8s.core.v1.ConfigMap(
    "netbird-config",
    {
      metadata: { name: "netbird-config", namespace: ns.metadata.name },
      data: { "config.yaml": configYaml },
    },
    { provider },
  );

  const pvc = new k8s.core.v1.PersistentVolumeClaim(
    "netbird-data",
    {
      metadata: { name: "netbird-data", namespace: ns.metadata.name },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName,
        resources: { requests: { storage: "1Gi" } },
      },
    },
    { provider },
  );

  // Combined NetBird server (management + signal + relay + STUN + embedded Dex)
  // Image: netbirdio/netbird-server (not netbirdio/netbird which is the client)
  const serverDeployment = new k8s.apps.v1.Deployment(
    "netbird-server",
    {
      metadata: { name: "netbird-server", namespace: ns.metadata.name },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: "netbird-server" } },
        template: {
          metadata: { labels: { app: "netbird-server" } },
          spec: {
            containers: [
              {
                name: "netbird-server",
                image: "netbirdio/netbird-server:0.66.4",
                args: ["--config", "/etc/netbird/config.yaml"],
                ports: [
                  { name: "http", containerPort: 80 },
                  { name: "stun", containerPort: 3478, protocol: "UDP" },
                ],
                volumeMounts: [
                  {
                    name: "config",
                    mountPath: "/etc/netbird",
                    readOnly: true,
                  },
                  { name: "data", mountPath: "/var/lib/netbird" },
                ],
              },
            ],
            volumes: [
              {
                name: "config",
                configMap: { name: configMap.metadata.name },
              },
              {
                name: "data",
                persistentVolumeClaim: { claimName: pvc.metadata.name },
              },
            ],
          },
        },
      },
    },
    { provider },
  );

  const serverSvc = new k8s.core.v1.Service(
    "netbird-server",
    {
      metadata: { name: "netbird-server", namespace: ns.metadata.name },
      spec: {
        selector: { app: "netbird-server" },
        ports: [{ name: "http", port: 80, targetPort: 80 }],
      },
    },
    { provider },
  );

  // STUN needs direct UDP - bypass Traefik via LoadBalancer
  new k8s.core.v1.Service(
    "netbird-stun",
    {
      metadata: { name: "netbird-stun", namespace: ns.metadata.name },
      spec: {
        type: "LoadBalancer",
        loadBalancerIP: stunIp,
        selector: { app: "netbird-server" },
        ports: [
          { name: "stun", port: 3478, targetPort: 3478, protocol: "UDP" },
        ],
      },
    },
    { provider },
  );

  // Dashboard
  new k8s.apps.v1.Deployment(
    "netbird-dashboard",
    {
      metadata: { name: "netbird-dashboard", namespace: ns.metadata.name },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "netbird-dashboard" } },
        template: {
          metadata: { labels: { app: "netbird-dashboard" } },
          spec: {
            containers: [
              {
                name: "dashboard",
                image: "netbirdio/dashboard:v2.34.2",
                ports: [{ name: "http", containerPort: 80 }],
                env: [
                  {
                    name: "NETBIRD_MGMT_API_ENDPOINT",
                    value: `https://${domain}`,
                  },
                  {
                    name: "NETBIRD_MGMT_GRPC_API_ENDPOINT",
                    value: `https://${domain}`,
                  },
                  {
                    name: "AUTH_AUTHORITY",
                    value: `https://${domain}/oauth2`,
                  },
                  { name: "AUTH_CLIENT_ID", value: "netbird-dashboard" },
                  { name: "AUTH_AUDIENCE", value: "netbird-dashboard" },
                  { name: "USE_AUTH0", value: "false" },
                  {
                    name: "AUTH_SUPPORTED_SCOPES",
                    value: "openid profile email groups",
                  },
                  { name: "AUTH_REDIRECT_URI", value: "/nb-auth" },
                  {
                    name: "AUTH_SILENT_REDIRECT_URI",
                    value: "/nb-silent-auth",
                  },
                  { name: "LETSENCRYPT_DOMAIN", value: "none" },
                ],
              },
            ],
          },
        },
      },
    },
    { provider },
  );

  const dashboardSvc = new k8s.core.v1.Service(
    "netbird-dashboard",
    {
      metadata: { name: "netbird-dashboard", namespace: ns.metadata.name },
      spec: {
        selector: { app: "netbird-dashboard" },
        ports: [{ name: "http", port: 80, targetPort: 80 }],
      },
    },
    { provider },
  );

  // TLS certificate via cert-manager
  new k8s.apiextensions.CustomResource(
    "netbird-cert",
    {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: { name: "netbird-tls", namespace: ns.metadata.name },
      spec: {
        secretName: "netbird-tls",
        issuerRef: { name: "letsencrypt-prod", kind: "ClusterIssuer" },
        dnsNames: [domain],
      },
    },
    { provider },
  );

  // Traefik routing - mirrors the official docker-compose Traefik labels from
  // infrastructure_files/getting-started.sh: gRPC paths use h2c scheme,
  // HTTP paths (api, oauth2, relay, ws-proxy) use standard HTTP,
  // dashboard catches everything else at lowest priority.

  // gRPC (h2c backend for signal + management gRPC)
  new k8s.apiextensions.CustomResource(
    "netbird-grpc-route",
    {
      apiVersion: "traefik.io/v1alpha1",
      kind: "IngressRoute",
      metadata: { name: "netbird-grpc", namespace: ns.metadata.name },
      spec: {
        entryPoints: ["websecure"],
        routes: [
          {
            match: `Host(\`${domain}\`) && PathPrefix(\`/signalexchange.SignalExchange/\`)`,
            kind: "Rule",
            services: [
              { name: serverSvc.metadata.name, port: 80, scheme: "h2c" },
            ],
          },
          {
            match: `Host(\`${domain}\`) && PathPrefix(\`/management.ManagementService/\`)`,
            kind: "Rule",
            services: [
              { name: serverSvc.metadata.name, port: 80, scheme: "h2c" },
            ],
          },
        ],
        tls: { secretName: "netbird-tls" },
      },
    },
    { provider },
  );

  // Traefik IngressRoute - server HTTP (api, oauth2, relay, websocket)
  new k8s.apiextensions.CustomResource(
    "netbird-backend-route",
    {
      apiVersion: "traefik.io/v1alpha1",
      kind: "IngressRoute",
      metadata: { name: "netbird-backend", namespace: ns.metadata.name },
      spec: {
        entryPoints: ["websecure"],
        routes: [
          {
            match: `Host(\`${domain}\`) && PathPrefix(\`/api\`)`,
            kind: "Rule",
            services: [{ name: serverSvc.metadata.name, port: 80 }],
          },
          {
            match: `Host(\`${domain}\`) && PathPrefix(\`/oauth2\`)`,
            kind: "Rule",
            services: [{ name: serverSvc.metadata.name, port: 80 }],
          },
          {
            match: `Host(\`${domain}\`) && PathPrefix(\`/relay\`)`,
            kind: "Rule",
            services: [{ name: serverSvc.metadata.name, port: 80 }],
          },
          {
            match: `Host(\`${domain}\`) && PathPrefix(\`/ws-proxy/\`)`,
            kind: "Rule",
            services: [{ name: serverSvc.metadata.name, port: 80 }],
          },
        ],
        tls: { secretName: "netbird-tls" },
      },
    },
    { provider },
  );

  // Traefik IngressRoute - dashboard (catch-all, lowest priority)
  new k8s.apiextensions.CustomResource(
    "netbird-dashboard-route",
    {
      apiVersion: "traefik.io/v1alpha1",
      kind: "IngressRoute",
      metadata: { name: "netbird-dashboard", namespace: ns.metadata.name },
      spec: {
        entryPoints: ["websecure"],
        routes: [
          {
            match: `Host(\`${domain}\`)`,
            kind: "Rule",
            priority: 1,
            services: [{ name: dashboardSvc.metadata.name, port: 80 }],
          },
        ],
        tls: { secretName: "netbird-tls" },
      },
    },
    { provider },
  );

  return {
    relayAuthSecret: relayAuthSecret.result,
    serverDeployment,
    namespace: ns,
  };
}

interface RouterArgs {
  provider: k8s.Provider;
  namespace: k8s.core.v1.Namespace;
  setupKey: pulumi.Output<string>;
}

export function deployRouter(args: RouterArgs) {
  const { provider, namespace, setupKey } = args;
  const config = new pulumi.Config();
  const traefikIp = config.require("traefikIp");

  const setupKeySecret = new k8s.core.v1.Secret(
    "netbird-router-key",
    {
      metadata: {
        name: "netbird-router-key",
        namespace: namespace.metadata.name,
      },
      stringData: { setupKey },
    },
    { provider },
  );

  new k8s.apps.v1.Deployment(
    "netbird-router",
    {
      metadata: {
        name: "netbird-router",
        namespace: namespace.metadata.name,
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: "netbird-router" } },
        template: {
          metadata: { labels: { app: "netbird-router" } },
          spec: {
            // The management server's exposedAddress uses the public domain,
            // which CoreDNS can't resolve (local DNS override in Unifi).
            hostAliases: [{ ip: traefikIp, hostnames: [domain] }],
            containers: [
              {
                name: "netbird",
                image: "netbirdio/netbird:0.66.4",
                env: [
                  {
                    name: "NB_SETUP_KEY",
                    valueFrom: {
                      secretKeyRef: {
                        name: setupKeySecret.metadata.name,
                        key: "setupKey",
                      },
                    },
                  },
                  {
                    name: "NB_MANAGEMENT_URL",
                    value: "http://netbird-server.netbird.svc.cluster.local",
                  },
                  {
                    name: "NB_HOSTNAME",
                    value: "k8s-router",
                  },
                  {
                    name: "NB_LOG_LEVEL",
                    value: "info",
                  },
                ],
                securityContext: {
                  capabilities: {
                    add: ["NET_ADMIN", "SYS_RESOURCE", "SYS_ADMIN"],
                  },
                },
              },
            ],
          },
        },
      },
    },
    { provider },
  );
}
