import * as pulumi from "@pulumi/pulumi";
import * as netbird from "@pulumi/netbird";

export function configureNetbird(
  provider: netbird.Provider,
  dependsOn: pulumi.Resource[],
) {
  const opts = { provider, dependsOn };

  // Look up the built-in "All" group
  const allGroup = netbird.getGroupOutput({ name: "All" }, { provider });

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

  // DNS zone for internal service names
  const zone = new netbird.DnsZone(
    "home-internal",
    {
      name: "home.internal",
      domain: "home.internal",
      enabled: true,
      enableSearchDomain: true,
      distributionGroups: [allGroup.apply((g) => g.id)],
    },
    opts,
  );

  // DNS records for cluster services
  new netbird.DnsRecord(
    "z2m-dns",
    {
      name: "z2m.home.internal",
      zoneId: zone.id,
      type: "A",
      content: "10.105.119.13",
      ttl: 300,
    },
    opts,
  );

  return { setupKey: setupKey.key };
}
