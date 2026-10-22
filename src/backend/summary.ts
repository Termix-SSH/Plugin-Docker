import type { Client } from "ssh2";
import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { containerCommand } from "./container-runtime.js";
import { PS_STATE_FORMAT, parseContainerStates } from "./container-state.js";
import { getErrorMessage } from "./helpers.js";
import { readDockerHostSettings } from "./host-settings.js";
import { execOnClient } from "./sessions.js";

const POOL = "docker";
const CACHE_MS = 60_000;
const TIMEOUT_MS = 20_000;
/** Hosts checked at once, so a big fleet does not open every connection together. */
export const SUMMARY_CONCURRENCY = 4;

export interface HostContainerSummary {
  hostId: number;
  running: number;
  stopped: number;
  unhealthy: number;
  total: number;
  error?: string;
  checkedAt: string;
}

/** Runs `fn` over `items`, at most `limit` at a time, keeping their order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/** Counts from `ps -a --format PS_STATE_FORMAT` output. */
export function countContainers(
  output: string,
): Omit<HostContainerSummary, "hostId" | "checkedAt"> {
  const states = [...parseContainerStates(output).values()];
  const running = states.filter((s) => s.state === "running").length;
  return {
    running,
    stopped: states.length - running,
    unhealthy: states.filter((s) => s.unhealthy).length,
    total: states.length,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The host did not answer in time")),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * GET /summary: container counts for every host the caller can reach with
 * Docker on. Each host is checked as the caller over the pooled connection,
 * a few at a time, and kept for a minute so a dashboard full of viewers does
 * not run docker ps on every refresh.
 */
export function registerSummary(router: Router, ctx: PluginContext): void {
  const cache = new Map<string, HostContainerSummary>();

  const check = async (hostId: number): Promise<HostContainerSummary> => {
    const checkedAt = new Date().toISOString();
    try {
      const { runtime } = await readDockerHostSettings(ctx, hostId);
      const output = await withTimeout(
        ctx.ssh.withConnection<string, Client>(
          hostId,
          { pool: POOL, purpose: "docker", profile: "session" },
          (client) =>
            execOnClient(
              client,
              containerCommand(runtime, `ps -a --format ${PS_STATE_FORMAT}`),
            ),
        ),
        TIMEOUT_MS,
      );
      return { hostId, checkedAt, ...countContainers(output) };
    } catch (error) {
      return {
        hostId,
        checkedAt,
        running: 0,
        stopped: 0,
        unhealthy: 0,
        total: 0,
        error: getErrorMessage(error, "Could not reach the host"),
      };
    }
  };

  /**
   * @openapi
   * /plugin-api/docker/summary:
   *   get:
   *     summary: Container counts on every Docker host
   *     description: Running, stopped and unhealthy containers on each host the caller can reach with Docker turned on. Results are kept for a minute; refresh=1 checks again.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: query
   *         name: refresh
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: One entry per host.
   */
  router.get("/summary", async (req: Request, res: Response) => {
    try {
      const user = String(ctx.currentActor() ?? "");
      const refresh = req.query.refresh === "1";
      const hosts = await ctx.hosts.list();
      const enabled: number[] = [];
      for (const host of hosts) {
        if ((await readDockerHostSettings(ctx, host.id)).enabled) {
          enabled.push(host.id);
        }
      }
      const now = Date.now();
      const results = await mapLimit(
        enabled,
        SUMMARY_CONCURRENCY,
        async (hostId) => {
          const key = `${user}:${hostId}`;
          const cached = cache.get(key);
          if (
            !refresh &&
            cached &&
            now - Date.parse(cached.checkedAt) < CACHE_MS
          ) {
            return cached;
          }
          const fresh = await check(hostId);
          cache.set(key, fresh);
          return fresh;
        },
      );
      res.json(results);
    } catch (error) {
      ctx.log.error(
        "Failed to build the Docker summary",
        error instanceof Error ? error : undefined,
      );
      res.status(500).json({ error: "Failed to build the Docker summary" });
    }
  });
}
