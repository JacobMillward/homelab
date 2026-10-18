import { ScrapeTarget } from "./agent-config";

export const SCRAPE_TARGETS: ScrapeTarget[] = [
  { job: "longhorn", namespace: "longhorn-system", labelSelector: "app=longhorn-manager", port: 9500, path: "/metrics" },
  { job: "cert-manager", namespace: "cert-manager", labelSelector: "app.kubernetes.io/component=controller", port: 9402, path: "/metrics" },
  { job: "crowdsec", namespace: "crowdsec", labelSelector: "k8s-app=crowdsec,type=lapi", port: 6060, path: "/metrics" },
  { job: "authelia", namespace: "authelia", labelSelector: "app=authelia", port: 9959, path: "/metrics" },
  { job: "netbird", namespace: "netbird", labelSelector: "app=netbird-server", port: 9090, path: "/metrics" },
  { job: "postgres", namespace: "", labelSelector: "cnpg.io/podRole=instance", port: 9187, path: "/metrics" },
  { job: "forgejo", namespace: "forgejo", labelSelector: "app=forgejo", port: 3000, path: "/metrics", bearerTokenEnvVar: "FORGEJO_METRICS_TOKEN" },
];
