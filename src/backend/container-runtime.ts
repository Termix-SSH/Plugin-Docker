export type ContainerRuntime = "docker" | "podman";

export function normalizeContainerRuntime(value: unknown): ContainerRuntime {
  return value === "podman" ? "podman" : "docker";
}

/**
 * Non-interactive SSH shells don't source ~/.zprofile or ~/.bash_profile,
 * so PATH additions from installers like Homebrew or OrbStack are missing.
 * Extend PATH with their common install locations before invoking the CLI.
 */
const EXTRA_PATH_DIRS =
  '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:"$HOME/.orbstack/bin"';

export function containerCommand(
  runtime: ContainerRuntime | undefined,
  args: string,
  isWindows = false,
): string {
  const cli = `${normalizeContainerRuntime(runtime)} ${args}`;
  // cmd and PowerShell don't understand the POSIX env prefix.
  return isWindows ? cli : `PATH="${EXTRA_PATH_DIRS}:$PATH" ${cli}`;
}

export function getRuntimeLabel(runtime: ContainerRuntime): string {
  return runtime === "podman" ? "Podman" : "Docker";
}
