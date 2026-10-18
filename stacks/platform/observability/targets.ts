import { ScrapeTarget } from "./agent-config";

export const SCRAPE_TARGETS: ScrapeTarget[] = [
  { job: "longhorn", namespace: "longhorn-system", labelSelector: "app=longhorn-manager", port: 9500, path: "/metrics" },
  { job: "cert-manager", namespace: "cert-manager", labelSelector: "app.kubernetes.io/name in (cert-manager,webhook,cainjector)", port: 9402, path: "/metrics" },
  { job: "crowdsec", namespace: "crowdsec", labelSelector: "k8s-app=crowdsec", port: 6060, path: "/metrics" },
  { job: "authelia", namespace: "authelia", labelSelector: "app=authelia", port: 9959, path: "/metrics" },
  { job: "netbird", namespace: "netbird", labelSelector: "app=netbird-server", port: 9090, path: "/metrics" },
  { job: "cnpg-operator", namespace: "cnpg-system", labelSelector: "app.kubernetes.io/name=cloudnative-pg", port: 8080, path: "/metrics" },
  { job: "postgres", namespace: "", labelSelector: "cnpg.io/podRole=instance", port: 9187, path: "/metrics" },
  { job: "forgejo", namespace: "forgejo", labelSelector: "app=forgejo", port: 3000, path: "/metrics", bearerTokenEnvVar: "FORGEJO_METRICS_TOKEN" },
  { job: "external-secrets", namespace: "external-secrets", labelSelector: "app.kubernetes.io/name in (external-secrets,external-secrets-webhook,external-secrets-cert-controller)", port: 8080, path: "/metrics" },
  { job: "onepassword-connect", namespace: "onepassword-connect", labelSelector: "app=onepassword-connect", port: 8080, path: "/metrics" },
  { job: "ntfy", namespace: "ntfy", labelSelector: "app=ntfy", port: 9091, path: "/metrics" },
  { job: "zot", namespace: "registry", labelSelector: "app=registry", port: 5000, path: "/metrics" },
];
