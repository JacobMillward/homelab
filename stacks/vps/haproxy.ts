export interface HaproxyConfigArgs {
  homeTunnelIp: string;
  metricsBind: string;
}

export function buildHaproxyConfig({ homeTunnelIp, metricsBind }: HaproxyConfigArgs): string {
  // The Prometheus endpoint has no auth, so it may only listen on loopback.
  if (!/^(127\.\d+\.\d+\.\d+|localhost|\[::1\]):\d+$/.test(metricsBind)) {
    throw new Error(`metricsBind must be a loopback address, got "${metricsBind}"`);
  }
  // The HTTPS check sends PROXY like the real traffic (Traefik only accepts PROXY from
  // the pod network), and a slow interval keeps check connections out of its logs.
  return `global
    maxconn 4096
    log stdout format raw local0

defaults
    mode tcp
    log global
    option tcplog
    timeout connect 5s
    timeout client 1h
    timeout server 1h

frontend app_publish
    bind *:443
    default_backend home_traefik

backend home_traefik
    server home ${homeTunnelIp}:443 send-proxy check check-send-proxy inter 30s

frontend forgejo_ssh
    bind *:22
    default_backend home_forgejo_ssh

backend home_forgejo_ssh
    server home ${homeTunnelIp}:22 check inter 30s

frontend metrics
    mode http
    bind ${metricsBind}
    http-request use-service prometheus-exporter if { path /metrics }
    no log
`;
}
