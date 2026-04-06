import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";

const domain = "netbird.millward-yuan.net";

interface VpsServerConfig {
  relayAuthSecret: pulumi.Input<string>;
  relayAddress: pulumi.Input<string>;
  stunAddress: pulumi.Input<string>;
}

interface ServerArgs {
  provider: k8s.Provider;
  storageClassName: string;
  vps?: VpsServerConfig;
}

export function deployServer(args: ServerArgs) {
  const { provider, storageClassName, vps } = args;
  const config = new pulumi.Config();

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

  // Use VPS relay secret when available, otherwise the local one
  const effectiveRelaySecret = vps
    ? pulumi.output(vps.relayAuthSecret)
    : relayAuthSecret.result;

  // config.yaml - matches combined/config.yaml.example from the netbird repo.
  // When VPS is configured, adds relays/stuns sections (disables embedded relay)
  // and advertises the VPS-hosted relay and STUN to all peers.
  const configYaml = pulumi
    .all([
      effectiveRelaySecret,
      encryptionKey.base64,
      vps ? pulumi.output(vps.relayAddress) : pulumi.output(""),
      vps ? pulumi.output(vps.stunAddress) : pulumi.output(""),
    ])
    .apply(([relaySecret, encKey, relayAddr, stunAddr]) => {
      let yaml = `server:
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
`;

      if (relayAddr && stunAddr) {
        yaml += `  relays:
    addresses:
      - "${relayAddr}"
    secret: "${relaySecret}"
    credentialsTTL: "24h"
  stuns:
    - uri: "${stunAddr}"
      proto: "udp"
`;
      }

      return yaml;
    });

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

  // Combined NetBird server (management + signal + STUN + embedded Dex)
  // Relay is disabled when VPS provides an external relay.
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

  // STUN needs direct UDP - bypass Traefik via LoadBalancer.
  // Skipped when VPS provides STUN externally.
  if (!vps) {
    const stunIp = config.require("netbirdStunIp");
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
  }

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

  // Local HTTP route for the Pulumi NetBird provider to reach the API
  // without depending on public DNS (which points to the VPS).
  const localApiRoute = new k8s.apiextensions.CustomResource(
    "netbird-local-api-route",
    {
      apiVersion: "traefik.io/v1alpha1",
      kind: "IngressRoute",
      metadata: { name: "netbird-local-api", namespace: ns.metadata.name },
      spec: {
        entryPoints: ["web"],
        routes: [
          {
            match: "PathPrefix(`/api`)",
            kind: "Rule",
            services: [{ name: serverSvc.metadata.name, port: 80 }],
          },
          {
            match: "PathPrefix(`/oauth2`)",
            kind: "Rule",
            services: [{ name: serverSvc.metadata.name, port: 80 }],
          },
        ],
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
    relayAuthSecret: effectiveRelaySecret,
    serverDeployment,
    localApiRoute,
    namespace: ns,
  };
}

interface RouterArgs {
  provider: k8s.Provider;
  namespace: k8s.core.v1.Namespace;
  storageClassName: string;
  setupKey: pulumi.Output<string>;
}

export function deployRouter(args: RouterArgs) {
  const { provider, namespace, storageClassName, setupKey } = args;

  const routerPvc = new k8s.core.v1.PersistentVolumeClaim(
    "netbird-router-config",
    {
      metadata: {
        name: "netbird-router-config",
        namespace: namespace.metadata.name,
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName,
        resources: { requests: { storage: "64Mi" } },
      },
    },
    { provider },
  );

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
                volumeMounts: [{ name: "config", mountPath: "/etc/netbird" }],
              },
            ],
            volumes: [
              {
                name: "config",
                persistentVolumeClaim: { claimName: routerPvc.metadata.name },
              },
            ],
          },
        },
      },
    },
    { provider },
  );
}

// ---------------------------------------------------------------------------
// WireGuard tunnel endpoint (only when VPS is configured)
// ---------------------------------------------------------------------------

interface WgPeerArgs {
  provider: k8s.Provider;
  namespace: k8s.core.v1.Namespace;
  vpsIp: pulumi.Input<string>;
  vpsWgPublicKey: pulumi.Input<string>;
  homeWgPrivateKey: pulumi.Input<string>;
}

export function deployWgPeer(args: WgPeerArgs) {
  const { provider, namespace, vpsIp, vpsWgPublicKey, homeWgPrivateKey } = args;

  const wgSecret = new k8s.core.v1.Secret(
    "wg-home-key",
    {
      metadata: {
        name: "wg-home-key",
        namespace: namespace.metadata.name,
      },
      stringData: {
        privateKey: homeWgPrivateKey,
      },
    },
    { provider },
  );

  const wgConfig = new k8s.core.v1.ConfigMap(
    "wg-home-config",
    {
      metadata: {
        name: "wg-home-config",
        namespace: namespace.metadata.name,
      },
      data: {
        "wg0.conf": pulumi.interpolate`[Interface]
Address = 10.99.0.2/24
PrivateKey = __WG_PRIVATE_KEY__

[Peer]
PublicKey = ${vpsWgPublicKey}
Endpoint = ${vpsIp}:51820
AllowedIPs = 10.99.0.1/32
PersistentKeepalive = 25
`,
      },
    },
    { provider },
  );

  const server = "netbird-server.netbird.svc.cluster.local";
  const dashboard = "netbird-dashboard.netbird.svc.cluster.local";

  const nginxConfig = new k8s.core.v1.ConfigMap(
    "wg-nginx-config",
    {
      metadata: {
        name: "wg-nginx-config",
        namespace: namespace.metadata.name,
      },
      data: {
        "default.conf": `server {
    listen 80;
    http2 on;
    # gRPC (h2c) - long-lived streams need extended timeouts
    grpc_read_timeout 24h;
    grpc_send_timeout 24h;
    location /signalexchange.SignalExchange/ {
        grpc_pass grpc://${server}:80;
    }
    location /management.ManagementService/ {
        grpc_pass grpc://${server}:80;
    }
    # API, OAuth, WebSocket
    location /api { proxy_pass http://${server}; }
    location /oauth2 { proxy_pass http://${server}; }
    location /ws-proxy/ {
        proxy_pass http://${server};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
    # Dashboard catch-all
    location / { proxy_pass http://${dashboard}; }
}
`,
      },
    },
    { provider },
  );

  // WireGuard tunnel to VPS with nginx for path-based routing to the
  // correct backend (server vs dashboard).
  new k8s.apps.v1.Deployment(
    "wg-home-peer",
    {
      metadata: {
        name: "wg-home-peer",
        namespace: namespace.metadata.name,
      },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: { app: "wg-home-peer" } },
        template: {
          metadata: { labels: { app: "wg-home-peer" } },
          spec: {
            initContainers: [
              {
                name: "setup-wg",
                image: "alpine:3.21",
                command: [
                  "sh",
                  "-c",
                  "cp /config/wg0.conf /etc/wireguard/wg0.conf && " +
                    'sed -i "s|__WG_PRIVATE_KEY__|$(cat /secret/privateKey)|" ' +
                    "/etc/wireguard/wg0.conf",
                ],
                volumeMounts: [
                  {
                    name: "wg-config",
                    mountPath: "/config",
                    readOnly: true,
                  },
                  {
                    name: "wg-secret",
                    mountPath: "/secret",
                    readOnly: true,
                  },
                  { name: "wg-run", mountPath: "/etc/wireguard" },
                ],
              },
            ],
            containers: [
              {
                name: "wireguard",
                image: "alpine:3.21",
                command: [
                  "sh",
                  "-c",
                  "apk add --no-cache wireguard-tools iproute2 && " +
                    "wg-quick up wg0 && " +
                    "trap 'wg-quick down wg0; exit 0' TERM INT && " +
                    "while :; do sleep 86400 & wait $!; done",
                ],
                securityContext: {
                  capabilities: { add: ["NET_ADMIN"] },
                },
                volumeMounts: [{ name: "wg-run", mountPath: "/etc/wireguard" }],
              },
              {
                name: "proxy",
                image: "nginx:1.27-alpine",
                ports: [{ containerPort: 80 }],
                volumeMounts: [
                  {
                    name: "nginx-config",
                    mountPath: "/etc/nginx/conf.d",
                    readOnly: true,
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "wg-config",
                configMap: { name: wgConfig.metadata.name },
              },
              {
                name: "wg-secret",
                secret: { secretName: wgSecret.metadata.name },
              },
              { name: "wg-run", emptyDir: {} },
              {
                name: "nginx-config",
                configMap: { name: nginxConfig.metadata.name },
              },
            ],
          },
        },
      },
    },
    { provider },
  );
}
