import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import { PlatformCtx } from "../context";

const domain = "netbird.millward-yuan.net";

export interface VpsServerConfig {
  relayAuthSecret: pulumi.Input<string>;
  relayAddress: pulumi.Input<string>;
  stunAddress: pulumi.Input<string>;
}

export interface NetbirdServerArgs {
  storageClassName: string;
  vps?: VpsServerConfig;
}

export class NetbirdServer extends pulumi.ComponentResource {
  readonly namespace: k8s.core.v1.Namespace;
  readonly relayAuthSecret: pulumi.Output<string>;
  readonly serverDeployment: k8s.apps.v1.Deployment;
  readonly localApiRoute: k8s.apiextensions.CustomResource;

  constructor(ctx: PlatformCtx, args: NetbirdServerArgs) {
    super("platform:netbird:Server", "netbird-server", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const { storageClassName, vps } = args;
    const config = new pulumi.Config();

    this.namespace = new k8s.core.v1.Namespace(
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
      { parent: this },
    );

    const relayAuthSecret = new random.RandomPassword("netbird-relay-secret", {
      length: 32,
      special: false,
    }, { parent: this });

    // NetBird base64-decodes the encryption key, so we need 44 chars (32 bytes encoded)
    const encryptionKey = new random.RandomBytes("netbird-encryption-key", {
      length: 32,
    }, { parent: this });

    // Use VPS relay secret when available, otherwise the local one
    const effectiveRelaySecret = vps
      ? pulumi.output(vps.relayAuthSecret)
      : relayAuthSecret.result;

    this.relayAuthSecret = effectiveRelaySecret;

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
        metadata: { name: "netbird-config", namespace: this.namespace.metadata.name },
        data: { "config.yaml": configYaml },
      },
      { parent: this },
    );

    const pvc = new k8s.core.v1.PersistentVolumeClaim(
      "netbird-data",
      {
        metadata: { name: "netbird-data", namespace: this.namespace.metadata.name },
        spec: {
          accessModes: ["ReadWriteOnce"],
          storageClassName,
          resources: { requests: { storage: "1Gi" } },
        },
      },
      { parent: this },
    );

    // Combined NetBird server (management + signal + STUN + embedded Dex)
    // Relay is disabled when VPS provides an external relay.
    this.serverDeployment = new k8s.apps.v1.Deployment(
      "netbird-server",
      {
        metadata: { name: "netbird-server", namespace: this.namespace.metadata.name },
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
      { parent: this },
    );

    const serverSvc = new k8s.core.v1.Service(
      "netbird-server",
      {
        metadata: { name: "netbird-server", namespace: this.namespace.metadata.name },
        spec: {
          selector: { app: "netbird-server" },
          ports: [{ name: "http", port: 80, targetPort: 80 }],
        },
      },
      { parent: this },
    );

    // STUN needs direct UDP - bypass Traefik via LoadBalancer.
    // Skipped when VPS provides STUN externally.
    if (!vps) {
      const stunIp = config.require("netbirdStunIp");
      new k8s.core.v1.Service(
        "netbird-stun",
        {
          metadata: { name: "netbird-stun", namespace: this.namespace.metadata.name },
          spec: {
            type: "LoadBalancer",
            loadBalancerIP: stunIp,
            selector: { app: "netbird-server" },
            ports: [
              { name: "stun", port: 3478, targetPort: 3478, protocol: "UDP" },
            ],
          },
        },
        { parent: this },
      );
    }

    // Dashboard
    new k8s.apps.v1.Deployment(
      "netbird-dashboard",
      {
        metadata: { name: "netbird-dashboard", namespace: this.namespace.metadata.name },
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
      { parent: this },
    );

    const dashboardSvc = new k8s.core.v1.Service(
      "netbird-dashboard",
      {
        metadata: { name: "netbird-dashboard", namespace: this.namespace.metadata.name },
        spec: {
          selector: { app: "netbird-dashboard" },
          ports: [{ name: "http", port: 80, targetPort: 80 }],
        },
      },
      { parent: this },
    );

    // TLS certificate via cert-manager
    new k8s.apiextensions.CustomResource(
      "netbird-cert",
      {
        apiVersion: "cert-manager.io/v1",
        kind: "Certificate",
        metadata: { name: "netbird-tls", namespace: this.namespace.metadata.name },
        spec: {
          secretName: "netbird-tls",
          issuerRef: { name: "letsencrypt-prod", kind: "ClusterIssuer" },
          dnsNames: [domain],
        },
      },
      { parent: this },
    );

    // Local HTTP route for the Pulumi NetBird provider to reach the API
    // without depending on public DNS (which points to the VPS).
    this.localApiRoute = new k8s.apiextensions.CustomResource(
      "netbird-local-api-route",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "IngressRoute",
        metadata: { name: "netbird-local-api", namespace: this.namespace.metadata.name },
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
      { parent: this },
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
        metadata: { name: "netbird-grpc", namespace: this.namespace.metadata.name },
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
      { parent: this },
    );

    // Traefik IngressRoute - server HTTP (api, oauth2, relay, websocket)
    new k8s.apiextensions.CustomResource(
      "netbird-backend-route",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "IngressRoute",
        metadata: { name: "netbird-backend", namespace: this.namespace.metadata.name },
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
      { parent: this },
    );

    // Traefik IngressRoute - dashboard (catch-all, lowest priority)
    new k8s.apiextensions.CustomResource(
      "netbird-dashboard-route",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "IngressRoute",
        metadata: { name: "netbird-dashboard", namespace: this.namespace.metadata.name },
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
      { parent: this },
    );
  }
}
