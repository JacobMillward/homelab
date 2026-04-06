import * as pulumi from "@pulumi/pulumi";
import * as netbird from "@pulumi/netbird";

export function configureNetbird(
  provider: netbird.Provider,
  dependsOn: pulumi.Resource[],
) {
  const opts = { provider, dependsOn };

  // Look up the built-in "All" group.
  // dependsOn ensures this waits for the server and its IngressRoute to
  // be deployed before making API calls.
  const allGroup = netbird.getGroupOutput({ name: "All" }, opts);

  // Group for the k8s routing peer
  const routerGroup = new netbird.Group(
    "k8s-routers",
    { name: "k8s-routers" },
    opts,
  );

  // Setup key for the routing peer, auto-assigns to k8s-routers group
  const setupKey = new netbird.SetupKey(
    "k8s-router-setup-key",
    {
      name: "k8s-router",
      type: "reusable",
      autoGroups: [routerGroup.id],
      expirySeconds: 365 * 24 * 60 * 60,
      usageLimit: 0,
    },
    opts,
  );

  // Network representing the cluster service CIDR
  const k8sNetwork = new netbird.Network(
    "k8s-services",
    {
      name: "k8s-services",
      description: "Kubernetes cluster services (10.96.0.0/12)",
    },
    opts,
  );

  // Expose the service CIDR as a network resource
  new netbird.NetworkResource(
    "k8s-service-cidr",
    {
      name: "k8s-service-cidr",
      networkId: k8sNetwork.id,
      address: "10.96.0.0/12",
      description: "Kubernetes service CIDR",
      groups: [allGroup.apply((g) => g.id)],
      enabled: true,
    },
    opts,
  );

  // Route traffic through the k8s-router peer group
  new netbird.NetworkRouter(
    "k8s-router",
    {
      networkId: k8sNetwork.id,
      peerGroups: [routerGroup.id],
      masquerade: true,
      metric: 9999,
      enabled: true,
    },
    opts,
  );

  // DNS zone for app subdomains (*.millward-yuan.net)
  const zone = new netbird.DnsZone(
    "millward-yuan",
    {
      name: "millward-yuan.net",
      domain: "millward-yuan.net",
      enabled: true,
      enableSearchDomain: false,
      distributionGroups: [allGroup.apply((g) => g.id)],
    },
    opts,
  );

  return { setupKey: setupKey.key, dnsZoneId: zone.id };
}
