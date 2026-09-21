import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import { dockerImage, DOMAIN } from "homelab-lib";
import { PlatformCtx } from "../context";
import { ForwardAuthSpec } from "../traefik";

export interface VpsServerConfig {
  relayAddress: pulumi.Input<string>;
  stunAddress: pulumi.Input<string>;
}

export interface NetbirdServerArgs {
  storageClassName: string;
  traefikIp: string;
  forwardAuthSpec: ForwardAuthSpec;
  vps?: VpsServerConfig;
  secretStoreName?: pulumi.Input<string>;
}

export class NetbirdServer extends pulumi.ComponentResource {
  readonly namespace: k8s.core.v1.Namespace;
  readonly serverDeployment: k8s.apps.v1.Deployment;
  readonly localApiRoute: k8s.apiextensions.CustomResource;

  constructor(ctx: PlatformCtx, args: NetbirdServerArgs) {
    super("platform:netbird:Server", "netbird-server", {}, {
      providers: { kubernetes: ctx.k8sProvider },
    });

    const { storageClassName, vps, traefikIp, forwardAuthSpec, secretStoreName } = args;
    const config = new pulumi.Config();
    const domain = `netbird.${DOMAIN}`;

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

    let vpsSecretsExternalSecret: k8s.apiextensions.CustomResource | undefined;
    if (vps && secretStoreName) {
      vpsSecretsExternalSecret = new k8s.apiextensions.CustomResource(
        "vps-secrets",
        {
          apiVersion: "external-secrets.io/v1",
          kind: "ExternalSecret",
          metadata: { name: "vps-secrets", namespace: this.namespace.metadata.name },
          spec: {
            secretStoreRef: { name: secretStoreName, kind: "ClusterSecretStore" },
            target: { name: "vps-secrets" },
            data: [
              { secretKey: "relay-auth-secret", remoteRef: { key: "VPS Secrets", property: "Relay Auth Secret" } },
              { secretKey: "home-wg-private-key", remoteRef: { key: "VPS Secrets", property: "Home Wg Private Key" } },
            ],
          },
        },
        { parent: this },
      );
    }

    const relayAuthSecret = new random.RandomPassword("netbird-relay-secret", {
      length: 32,
      special: false,
    }, { parent: this });

    const relaySecretPlaceholder = "__RELAY_AUTH_SECRET__";
    const effectiveRelaySecret = vps ? relaySecretPlaceholder : relayAuthSecret.result;

    const encryptionKey = new random.RandomBytes("netbird-encryption-key", {
      length: 32,
    }, { parent: this });

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
  logLevel: "info"
  logFile: "console"
  authSecret: "${relaySecret}"
  dataDir: "/var/lib/netbird"
  auth:
    issuer: "https://${domain}/oauth2"
    localAuthDisabled: true
    signKeyRefreshEnabled: true
    dashboardRedirectURIs:
      - "https://${domain}/nb-auth"
      - "https://${domain}/nb-silent-auth"
      - "https://dashboard.internal.${DOMAIN}/nb-auth"
      - "https://dashboard.internal.${DOMAIN}/nb-silent-auth"
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
          progressDeadlineSeconds: 120,
          selector: { matchLabels: { app: "netbird-server" } },
          template: {
            metadata: { labels: { app: "netbird-server" } },
            spec: {
              hostAliases: [
                {
                  ip: traefikIp,
                  hostnames: [`auth.${DOMAIN}`],
                },
              ],
              containers: [
                {
                  name: "netbird-server",
                  image: dockerImage("netbirdServer"),
                  command: vps
                    ? [
                        "sh",
                        "-c",
                        `sed "s|${relaySecretPlaceholder}|$(cat /secrets/relay-auth-secret)|" /etc/netbird-template/config.yaml > /etc/netbird/config.yaml && exec /go/bin/netbird-server --config /etc/netbird/config.yaml`,
                      ]
                    : undefined,
                  args: vps ? undefined : ["--config", "/etc/netbird/config.yaml"],
                  ports: [
                    { name: "http", containerPort: 80 },
                    { name: "stun", containerPort: 3478, protocol: "UDP" },
                  ],
                  // /oauth2 returns 200 without auth. The relay healthcheck at
                  // :9000/health panics with a nil pointer when relay is not
                  // configured, so we probe the management HTTP port instead.
                  livenessProbe: {
                    httpGet: { path: "/oauth2", port: "http" },
                    initialDelaySeconds: 15,
                    periodSeconds: 20,
                  },
                  readinessProbe: {
                    httpGet: { path: "/oauth2", port: "http" },
                    initialDelaySeconds: 5,
                    periodSeconds: 10,
                  },
                  volumeMounts: vps
                    ? [
                        { name: "config-template", mountPath: "/etc/netbird-template", readOnly: true },
                        { name: "netbird-config-rendered", mountPath: "/etc/netbird" },
                        { name: "relay-secret", mountPath: "/secrets", readOnly: true },
                        { name: "data", mountPath: "/var/lib/netbird" },
                      ]
                    : [
                        { name: "config-template", mountPath: "/etc/netbird", readOnly: true },
                        { name: "data", mountPath: "/var/lib/netbird" },
                      ],
                },
              ],
              volumes: vps
                ? [
                    { name: "config-template", configMap: { name: configMap.metadata.name } },
                    { name: "netbird-config-rendered", emptyDir: {} },
                    { name: "relay-secret", secret: { secretName: "vps-secrets" } },
                    { name: "data", persistentVolumeClaim: { claimName: pvc.metadata.name } },
                  ]
                : [
                    { name: "config-template", configMap: { name: configMap.metadata.name } },
                    { name: "data", persistentVolumeClaim: { claimName: pvc.metadata.name } },
                  ],
            },
          },
        },
      },
      {
        parent: this,
        dependsOn: vpsSecretsExternalSecret ? [vpsSecretsExternalSecret] : [],
      },
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
          strategy: { type: "RollingUpdate", rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
          progressDeadlineSeconds: 120,
          selector: { matchLabels: { app: "netbird-dashboard" } },
          template: {
            metadata: { labels: { app: "netbird-dashboard" } },
            spec: {
              containers: [
                {
                  name: "dashboard",
                  image: dockerImage("netbirdDashboard"),
                  ports: [{ name: "http", containerPort: 80 }],
                  livenessProbe: {
                    httpGet: { path: "/", port: "http" },
                    initialDelaySeconds: 10,
                    periodSeconds: 20,
                  },
                  readinessProbe: {
                    httpGet: { path: "/", port: "http" },
                    initialDelaySeconds: 5,
                    periodSeconds: 10,
                  },
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

    // Dashboard moves to traefik-internal (mesh-only, no LAN path — same
    // pattern zigbee2mqtt uses) and gets Authelia's forwardAuth on top,
    // same as every other app. A same-namespace Middleware, not a
    // cross-namespace ref — see commit 576ed8f.
    const dashboardAutheliaMiddleware = new k8s.apiextensions.CustomResource(
      "netbird-dashboard-authelia-middleware",
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "Middleware",
        metadata: { name: "authelia", namespace: this.namespace.metadata.name },
        spec: { forwardAuth: forwardAuthSpec },
      },
      { parent: this },
    );

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
              match: `Host(\`dashboard.internal.${DOMAIN}\`)`,
              kind: "Rule",
              services: [{ name: dashboardSvc.metadata.name, port: 80 }],
              middlewares: [{ name: "authelia" }],
            },
          ],
          tls: {},
        },
      },
      { parent: this, dependsOn: [dashboardAutheliaMiddleware] },
    );
  }
}
