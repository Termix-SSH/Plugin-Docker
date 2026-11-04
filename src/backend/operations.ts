import type { Client } from "ssh2";
import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import { containerCommand } from "./container-runtime.js";
import { PS_STATE_FORMAT } from "./container-state.js";
import { readDockerHostSettings } from "./host-settings.js";
import { execOnClient, type DockerSessions } from "./sessions.js";
import { listFormat, parseContainerList } from "./routes.js";
import { countContainers } from "./summary.js";
import { CONTAINER_ID_RE } from "./helpers.js";

const POOL = "docker";

type ContainerVerb = "start" | "stop" | "restart" | "pause" | "unpause";

const VERBS: { verb: ContainerVerb; done: string }[] = [
  { verb: "start", done: "Started" },
  { verb: "stop", done: "Stopped" },
  { verb: "restart", done: "Restarted" },
  { verb: "pause", done: "Paused" },
  { verb: "unpause", done: "Resumed" },
];

function requireHost(context: PluginOperationContext): number {
  if (context.hostId === undefined) throw new Error("This needs a host");
  return context.hostId;
}

function requireContainer(context: PluginOperationContext): string {
  const container = context.resourceKey ?? "";
  if (!CONTAINER_ID_RE.test(container)) {
    throw new Error("Invalid container name");
  }
  return container;
}

/**
 * Runs on the person's open session when there is one, since only that knows a
 * Windows host and holds a login that took TOTP. Otherwise a pooled connection.
 */
function createRunner(ctx: PluginContext, sessions: DockerSessions) {
  return async (
    hostId: number,
    args: string | ((isWindows: boolean) => string),
  ): Promise<string> => {
    const build = typeof args === "string" ? () => args : args;
    const userId = ctx.currentActor();
    const session = userId ? sessions.forHost(userId, hostId) : undefined;
    if (session) {
      return sessions.run(session, () =>
        sessions.exec(
          session,
          containerCommand(
            session.runtime,
            build(session.isWindows),
            session.isWindows,
          ),
        ),
      );
    }
    const { runtime } = await readDockerHostSettings(ctx, hostId);
    return ctx.ssh.withConnection<string, Client>(
      hostId,
      { pool: POOL, purpose: "docker", profile: "session" },
      (client) => execOnClient(client, containerCommand(runtime, build(false))),
    );
  };
}

/** Everything Docker offers to the rest of Termix. See contributes.operations. */
export function registerOperations(
  ctx: PluginContext,
  sessions: DockerSessions,
): void {
  const exec = createRunner(ctx, sessions);

  ctx.operations.register("docker.list-containers", {
    run: async (_input, context) => {
      const output = await exec(
        requireHost(context),
        (isWindows) => `ps -a --format ${listFormat(isWindows)}`,
      );
      const rows = parseContainerList(output);
      return {
        summary: `${rows.length} containers`,
        data: { rows },
      };
    },
  });

  ctx.operations.register("docker.summary", {
    run: async (_input, context) => {
      const counts = countContainers(
        await exec(requireHost(context), `ps -a --format ${PS_STATE_FORMAT}`),
      );
      return {
        summary: `${counts.running} of ${counts.total} running`,
        data: {
          value: counts.unhealthy,
          status: counts.unhealthy > 0 ? "warn" : "ok",
          label: `${counts.running} of ${counts.total} running`,
        },
      };
    },
  });

  for (const { verb, done } of VERBS) {
    ctx.operations.register(`docker.${verb}-container`, {
      describe: (_input, context) =>
        `Would ${verb} container ${requireContainer(context)}`,
      run: async (_input, context) => {
        const container = requireContainer(context);
        await exec(requireHost(context), `${verb} ${container}`);
        return { summary: `${done} ${container}`, changed: true };
      },
    });
  }

  ctx.operations.register("docker.remove-container", {
    describe: (input, context) =>
      `Would remove container ${requireContainer(context)}${input.force ? " by force" : ""}`,
    run: async (input, context) => {
      const container = requireContainer(context);
      await exec(
        requireHost(context),
        `rm ${input.force ? "-f " : ""}${container}`,
      );
      return { summary: `Removed ${container}`, changed: true };
    },
  });
}
