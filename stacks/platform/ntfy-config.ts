export interface NtfyUser {
  name: string;
  passwordHash: string;
  role: "admin" | "user";
}

export interface NtfyToken {
  user: string;
  token: string;
  label: string;
}

export interface NtfyAccess {
  user: string;
  topic: string;
  permission: "read-write" | "read-only" | "write-only";
}

export interface NtfyConfigArgs {
  baseUrl: string;
  users: NtfyUser[];
  tokens: NtfyToken[];
  access: NtfyAccess[];
}

const SHORT = { "read-write": "rw", "read-only": "ro", "write-only": "wo" } as const;

// ntfy refuses tokens that do not start with tk_ and are 32 characters long.
const TOKEN_FORMAT = /^tk_[a-z0-9]{29}$/;

const list = (key: string, items: string[]) =>
  items.length ? `${key}:\n${items.map((i) => `  - ${JSON.stringify(i)}`).join("\n")}\n` : "";

export function buildNtfyServerConfig(args: NtfyConfigArgs): string {
  for (const t of args.tokens) {
    if (!TOKEN_FORMAT.test(t.token)) {
      throw new Error(`ntfy token for "${t.user}" must match tk_ + 29 lowercase alphanumerics`);
    }
  }
  return (
    `base-url: ${JSON.stringify(args.baseUrl)}\n` +
    `listen-http: ":8080"\n` +
    `behind-proxy: true\n` +
    // Own port, so Traefik never routes /metrics.
    `metrics-listen-http: ":9091"\n` +
    `cache-file: "/var/lib/ntfy/cache.db"\n` +
    `auth-file: "/var/lib/ntfy/user.db"\n` +
    `auth-default-access: "deny-all"\n` +
    list("auth-users", args.users.map((u) => `${u.name}:${u.passwordHash}:${u.role}`)) +
    list("auth-access", args.access.map((a) => `${a.user}:${a.topic}:${SHORT[a.permission]}`)) +
    list("auth-tokens", args.tokens.map((t) => `${t.user}:${t.token}:${t.label}`))
  );
}
