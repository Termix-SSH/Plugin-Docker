import type { StatusTone } from "@termix-ssh/plugin-sdk/ui";
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

/** The badge tone for a stack or service state. */
export function stackTone(state: string): StatusTone {
  if (state === "running" || state === "healthy") return "ok";
  if (state === "partial" || state === "paused") return "warn";
  if (state === "restarting" || state === "starting") return "warn";
  if (state === "dead" || state === "unhealthy") return "bad";
  return "idle";
}
