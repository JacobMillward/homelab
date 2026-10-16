export interface Forward {
  port: number;
  // An address, or a shell expression that wg-quick resolves when it brings the tunnel up.
  dest: string;
}

const rule = (op: "A" | "D", { port, dest }: Forward) =>
  [
    `iptables -t nat -${op} PREROUTING -p tcp --dport ${port} -j DNAT --to-destination ${dest}:${port}`,
    `iptables -${op} FORWARD -p tcp -d ${dest} --dport ${port} -j ACCEPT`,
    `iptables -t nat -${op} POSTROUTING -p tcp -d ${dest} --dport ${port} -j MASQUERADE`,
  ].join("; ");

export function buildForwardRules(forwards: Forward[]): { up: string; down: string } {
  return {
    up: forwards.map((f) => rule("A", f)).join("; "),
    down: forwards.map((f) => rule("D", f)).join("; "),
  };
}
