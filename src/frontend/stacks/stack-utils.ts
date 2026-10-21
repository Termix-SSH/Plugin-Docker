export type EnvLine =
  { kind: "kv"; key: string; value: string } | { kind: "raw"; text: string };

const KV_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/;

/** Splits an env file into key lines and untouched lines (comments, blanks). */
export function parseEnv(text: string): EnvLine[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => {
    const match = line.match(KV_RE);
    if (!match) return { kind: "raw", text: line };
    return { kind: "kv", key: match[1], value: match[2] };
  });
}

export function serializeEnv(lines: EnvLine[]): string {
  if (lines.length === 0) return "";
  const kept = lines.filter((line) => line.kind !== "kv" || line.key);
  if (kept.length === 0) return "";
  return (
    kept
      .map((line) =>
        line.kind === "kv" ? `${line.key}=${line.value}` : line.text,
      )
      .join("\n") + "\n"
  );
}

export const COMPOSE_TEMPLATE = `services:
  app:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "8080:80"
`;

export const STACK_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function stateClass(state: string): string {
  if (state === "running" || state === "healthy")
    return "border-accent-brand/40 text-accent-brand bg-accent-brand/10";
  if (state === "partial" || state === "paused")
    return "border-warning/40 text-warning bg-warning/10";
  if (state === "stopped" || state === "exited" || state === "dead")
    return "border-destructive/40 text-destructive bg-destructive/5";
  if (state === "restarting" || state === "starting")
    return "border-blue-400/40 text-blue-400 bg-blue-400/10";
  return "border-border text-muted-foreground";
}
