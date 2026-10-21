export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state:
    | "created"
    | "running"
    | "paused"
    | "restarting"
    | "removing"
    | "exited"
    | "dead";
  ports: string;
  created: string;
  command?: string;
  labels?: Record<string, string>;
  networks?: string[];
  mounts?: string[];
}

export interface DockerStats {
  cpu: string;
  memoryUsed: string;
  memoryLimit: string;
  memoryPercent: string;
  netInput: string;
  netOutput: string;
  blockRead: string;
  blockWrite: string;
  pids?: string;
}

export interface DockerLogOptions {
  tail?: number;
  timestamps?: boolean;
  since?: string;
  until?: string;
  follow?: boolean;
}

export interface DockerValidation {
  available: boolean;
  version?: string;
  runtime?: "docker" | "podman";
  error?: string;
  code?: string;
}

/** What the Docker views read from a host. */
export interface DockerHost {
  id: number;
  name?: string;
  ip: string;
  port: number;
  username?: string;
  syncId?: string | null;
  connectionOrigin?: "local" | "remote" | null;
  pluginSettings?: Record<string, Record<string, unknown> | undefined>;
}

/** The fields toDockerHost reads from a shell or API host. */
export type DockerHostSource = Omit<DockerHost, "id" | "name"> & {
  id: string | number;
  name?: string | null;
};

/** Any host record the shell or an API hands over, as a DockerHost. */
export function toDockerHost(record: DockerHostSource): DockerHost {
  return {
    id: Number(record.id),
    name: record.name ?? undefined,
    ip: record.ip,
    port: record.port,
    username: record.username,
    syncId: record.syncId ?? null,
    connectionOrigin: record.connectionOrigin ?? null,
    pluginSettings: record.pluginSettings,
  };
}

function dockerSettings(
  host: object | null | undefined,
): Record<string, unknown> {
  const all = (host as { pluginSettings?: unknown } | null | undefined)
    ?.pluginSettings as
    Record<string, Record<string, unknown> | undefined> | undefined;
  return all?.docker ?? {};
}

export function dockerEnabled(host: object | null | undefined): boolean {
  return dockerSettings(host).enableDocker === true;
}

/** Whether the side panel may open beside this host's terminal. */
export function dockerPanelEnabled(host: object | null | undefined): boolean {
  return dockerEnabled(host) && dockerSettings(host).showPanel !== false;
}

export function hostTitle(host: DockerHost): string {
  return host.name || `${host.username ?? ""}@${host.ip}`;
}

/** Whether this host turned stack management on (the admin switch is separate). */
export function stacksEnabledForHost(host: object | null | undefined): boolean {
  return dockerEnabled(host) && dockerSettings(host).enableStacks === true;
}

export type StackState =
  "running" | "partial" | "stopped" | "paused" | "not-deployed";

export interface StackSummary {
  name: string;
  managed: boolean;
  state: StackState;
  running: number;
  total: number;
  composeFile: string | null;
}

export interface StackService {
  service: string;
  name: string;
  id: string;
  image: string;
  state: string;
  status: string;
  health: string;
  ports: string;
}

export interface StackDetailData {
  name: string;
  managed: boolean;
  composeFile: string | null;
  compose: string | null;
  env: string | null;
  declaredServices: string[];
  services: StackService[];
  state: StackState;
  running: number;
  total: number;
}

export type StackAction =
  | "deploy"
  | "redeploy"
  | "pull"
  | "start"
  | "stop"
  | "restart"
  | "pause"
  | "unpause"
  | "down"
  | "destroy";

export type UpdateStatus = "update" | "current" | "unknown" | "pinned";

export interface ImageUpdate {
  status: UpdateStatus;
  reason?: string;
}
