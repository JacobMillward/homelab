import * as fs from "fs";
import * as path from "path";

export interface HelmChartRef {
  chart: string;
  version: string;
  registryUrl: string;
}

export interface DockerImageRef {
  image: string;
  tag: string;
}

export interface GoModuleRef {
  moduleName: string;
  version: string;
}

interface VersionsFile {
  helm: Record<string, HelmChartRef>;
  docker: Record<string, DockerImageRef>;
  go: Record<string, GoModuleRef>;
}

// Single source of truth for pinned dependency versions, tracked by
// Renovate via a JSONata custom manager instead of regex against source
// code — see renovate.json.
const versionsPath = path.join(__dirname, "version-pins.json");
const versions: VersionsFile = JSON.parse(fs.readFileSync(versionsPath, "utf8"));

export function helmChart(name: keyof VersionsFile["helm"]): HelmChartRef {
  const ref = versions.helm[name as string];
  if (!ref) throw new Error(`Unknown helm chart "${String(name)}" in lib/versions.json`);
  return ref;
}

export function dockerImage(name: keyof VersionsFile["docker"]): string {
  const ref = versions.docker[name as string];
  if (!ref) throw new Error(`Unknown docker image "${String(name)}" in lib/versions.json`);
  return `${ref.image}:${ref.tag}`;
}

export function goModule(name: keyof VersionsFile["go"]): GoModuleRef {
  const ref = versions.go[name as string];
  if (!ref) throw new Error(`Unknown go module "${String(name)}" in lib/versions.json`);
  return ref;
}
