import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as netbird from "@pulumi/netbird";
import { deployServer, deployRouter } from "./deploy";
import { configureNetbird } from "./config";

interface NetbirdArgs {
  k8sProvider: k8s.Provider;
  storageClassName: string;
}

// Orchestrates: server deploy → API config → router deploy.
// On a fresh deploy the server must be running before the NetBird
// API provider can create setup keys and network routes.
export function setupNetbird(args: NetbirdArgs) {
  const { k8sProvider, storageClassName } = args;
  const config = new pulumi.Config();

  // 1. Deploy server, dashboard, and ingress
  const server = deployServer({
    provider: k8sProvider,
    storageClassName,
  });

  // 2. Configure NetBird via API (groups, networks, DNS, setup key).
  //    Waits for the server deployment to be ready.
  const managementUrl = "https://netbird.millward-yuan.net";
  const pat = config.requireSecret("netbirdPat");

  const nbProvider = new netbird.Provider("netbird", {
    managementUrl,
    token: pat,
  });

  const nbConfig = configureNetbird(nbProvider, [server.serverDeployment]);

  // 3. Deploy the routing peer using the Pulumi-managed setup key
  deployRouter({
    provider: k8sProvider,
    namespace: server.namespace,
    setupKey: nbConfig.setupKey,
  });

  return {
    relayAuthSecret: server.relayAuthSecret,
    dnsZoneId: nbConfig.dnsZoneId,
    managementUrl,
    pat,
  };
}
