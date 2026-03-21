export interface Node {
    name: string;
    ip: string;
    installDisk: string;
    machineType: "controlplane" | "worker";
    schematic: string; // filename in talos/schematics/, e.g. "nuc12i7"
}
