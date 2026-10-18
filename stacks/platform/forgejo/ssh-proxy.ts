// Public SSH hits this sidecar's HAProxy first: it reads the PROXY header from
// the VPS, asks the CrowdSec SPOA bouncer about the real client IP, and only
// then forwards to Forgejo's built-in SSH server on loopback.
export const SSH_PUBLIC_PORT = 2222;
export const SSH_LISTEN_PORT = 2223;
export const SPOA_PORT = 9000;

export const PROXY_CONFIG_DIR = "/usr/local/etc/haproxy";
export const SPOA_CONFIG_PATH = "/etc/crowdsec/bouncers/crowdsec-spoa-bouncer.yaml";

export function buildSshProxyConfig(): string {
  return `global
    log stdout format raw local0
    maxconn 1000

defaults
    mode tcp
    log global
    option tcplog
    timeout connect 5s
    timeout client 1h
    timeout server 1h

frontend ssh
    bind :${SSH_PUBLIC_PORT} accept-proxy
    unique-id-format %{+X}o\\ %ci:%cp_%fi:%fp_%Ts_%rt:%pid
    tcp-request inspect-delay 2s
    filter spoe engine crowdsec config ${PROXY_CONFIG_DIR}/crowdsec.cfg
    tcp-request content send-spoe-group crowdsec crowdsec-tcp-group
    tcp-request content reject if { var(txn.crowdsec.remediation) -m str ban }
    default_backend forgejo

backend crowdsec-spoa
    timeout connect 2s
    timeout server 60s
    server spoa 127.0.0.1:${SPOA_PORT}

backend forgejo
    server forgejo 127.0.0.1:${SSH_LISTEN_PORT} send-proxy
`;
}

// A group, not an \`event\`: events fail with SPOE error 4 and never set the verdict.
export function buildSpoeConfig(): string {
  return `[crowdsec]
spoe-agent crowdsec-agent
    groups      crowdsec-tcp-group
    option      var-prefix  crowdsec
    option      set-on-error error
    timeout     hello       200ms
    timeout     idle        55s
    timeout     processing  500ms
    use-backend crowdsec-spoa
    log         global

spoe-message crowdsec-tcp
    args id=unique-id src-ip=src src-port=src_port

spoe-group crowdsec-tcp-group
    messages crowdsec-tcp
`;
}

export function buildSpoaBouncerConfig(apiUrl: string, apiKey: string): string {
  return `log_mode: stdout
log_level: info
update_frequency: 10s
api_url: ${apiUrl}
api_key: ${apiKey}
listen_tcp: 127.0.0.1:${SPOA_PORT}
`;
}
