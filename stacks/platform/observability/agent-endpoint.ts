// Static so Traefik (created before Observability) can point at it.
export const AGENT_NAMESPACE = "otel-agent";
export const AGENT_SERVICE = "otel-agent";
export const AGENT_OTLP_ENDPOINT = `http://${AGENT_SERVICE}.${AGENT_NAMESPACE}.svc.cluster.local:4318`;
