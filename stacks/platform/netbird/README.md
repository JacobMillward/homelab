# NetBird Stack

Self-hosted [NetBird](https://netbird.io) zero-trust networking. The server,
dashboard and routing peer run in the cluster. The relay and STUN run on the
Hetzner edge VPS.

## Architecture

The [network diagram](../../../README.md#network) in the root README shows how
public and mesh traffic reach the cluster, including the VPS tunnel that
carries NetBird's API and signal traffic.

### Traffic flows

**The NetBird API and signal** are served on `netbird.millward-yuan.net` by
IngressRoutes on the `websecure` entrypoint: h2c for the signal and management
gRPC paths, plain HTTP for `/api`, `/oauth2`, `/relay`, and `/ws-proxy/`.

**Relay and STUN** run in one container on the VPS, outside the tunnel. The
relay terminates its own TLS on :33443 with a certificate that an `acme.sh`
systemd timer issues and renews via Cloudflare DNS-01. STUN shares the process
on UDP :3478.

**Mesh-only services** live under `*.internal.millward-yuan.net`. A NetBird DNS
zone resolves those names to the `traefik-internal` ClusterIP, which is only
reachable through the `netbird-router` peer that advertises the cluster service
CIDR (10.96.0.0/12) with masquerading. There is no LAN or public path to them.
The NetBird dashboard sits here behind Authelia's forwardAuth middleware. The
image registry sits here too and uses its own htpasswd auth for pushes. A
`NameserverGroup` points peers at CoreDNS (10.96.0.10) for that domain, routed
the same way.

**Bootstrap access** uses its own IngressRoute on the `web` entrypoint. The
Pulumi NetBird provider talks to the API over HTTP at Traefik's LAN IP, because
public DNS points at a VPS that cannot proxy back until this same stack has
deployed the tunnel.

### Authentication

Authelia is the identity provider. The stack registers it through
`netbird.IdentityProvider`, and the server's embedded Dex federates to it. The
server's own local email login is disabled (`localAuthDisabled: true`).

Dex stores Authelia's client ID and secret in its SQLite store and does not
reload them on a rotation. A `DeploymentPatch` carries a hash of those
credentials and restarts the pod when they change. The restart is a separate
resource because the identity provider depends on the Deployment already
running. A hash on the Deployment itself would close a dependency cycle.

The server pod carries a `hostAliases` entry mapping `auth.millward-yuan.net` to
Traefik's static LoadBalancer IP, so in-cluster OIDC calls do not leave the LAN.

### Secrets

The relay auth secret and the home WireGuard private key originate in the VPS
stack and are read back through an `ExternalSecret` (1Password via ESO) as
`vps-secrets`. Both the server and the tunnel pod mount that secret and render
their config at start-up with `sed`, which keeps the values out of ConfigMaps
and out of the rendered manifests.

### Deployment order

1. Server, dashboard, IngressRoutes, TLS certificate
2. NetBird API config via the Pulumi provider (IdP, groups, network, DNS zone, setup key)
3. Router peer, using the setup key from step 2
4. WireGuard tunnel pod

## Runbooks

### VPS recreated / IP changed

The VPS holds a Hetzner Primary IP, which survives server replacement, so a
rebuild keeps the same address. The tunnel pod bakes the VPS IP and public key
into its config at deploy time, so when either one changes:

1. **Sync the new values into cluster config:**
   ```
   just up platform
   ```

2. **Restart the tunnel and routing pods:**
   ```
   just --justfile runbook.justfile netbird-bounce-vps
   ```

`netbird-server` does not need restarting. Its PVC data lives in the cluster,
and its config reaches the VPS by domain name.
