import type { Client } from "ssh2";
import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  containerCommand,
  countContainers,
} from "@termix-ssh/plugin-sdk/host-scripts";
import { PS_STATE_FORMAT } from "./container-state.js";
import { getErrorMessage } from "./helpers.js";
import { readDockerHostSettings } from "./host-settings.js";
import { execOnClient } from "./sessions.js";

const POOL = "docker";
const CACHE_MS = 60_000;
const TREE_CACHE_MS = 15_000;
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

export { countContainers };

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

/** `ps -a` on one host, as the acting user over the pooled connection. */
export async function readContainerOutput(
  ctx: PluginContext,
  hostId: number,
): Promise<string> {
  const { runtime } = await readDockerHostSettings(ctx, hostId);
  return withTimeout(
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
}

/** Containers that are unhealthy, restarting, dead or exited with an error. */
export function containerProblems(output: string) {
  const problems: Array<{ name: string; kind: string }> = [];
  for (const line of output.split(/\r?\n/)) {
    let row: { name?: string; state?: string; status?: string };
    try {
      row = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (!row.name) continue;
    const status = row.status ?? "";
    if (row.state === "restarting" || row.state === "dead") {
      problems.push({ name: row.name, kind: row.state });
    } else if (row.state === "exited") {
      const code = /Exited \((\d+)\)/.exec(status)?.[1];
      if (code && code !== "0")
        problems.push({ name: row.name, kind: "exited" });
    } else if (/\(unhealthy\)/.test(status)) {
      problems.push({ name: row.name, kind: "unhealthy" });
    }
  }
  return problems;
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
      const output = await readContainerOutput(ctx, hostId);
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
   *         name: hostId
   *         schema:
   *           type: integer
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
      const only = Number(req.query.hostId);
      const hosts = (await ctx.hosts.list()).filter(
        (host) => !Number.isInteger(only) || only <= 0 || host.id === only,
      );
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

export interface TreeContainer {
  name: string;
  state: string;
  status: string;
}

/** Every container in `ps -a` output, sorted by name. */
export function parseTreeContainers(output: string): TreeContainer[] {
  const rows: TreeContainer[] = [];
  for (const line of output.split(/\r?\n/)) {
    let row: { name?: string; state?: string; status?: string };
    try {
      row = JSON.parse(line.trim());
    } catch {
      continue;
    }
    if (!row.name) continue;
    rows.push({
      name: row.name,
      state: row.state ?? "",
      status: row.status ?? "",
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * GET /tree: the containers on one host, for layouts that list them under the
 * host in a tree. Kept for a few seconds per user, so opening and closing the
 * host does not run docker ps each time.
 */
export function registerTree(router: Router, ctx: PluginContext): void {
  const cache = new Map<string, { at: number; items: TreeContainer[] }>();

  /**
   * @openapi
   * /plugin-api/docker/tree:
   *   get:
   *     summary: Containers on one host
   *     description: Name, state and status of every container on a host the caller can reach with Docker turned on, for host tree layouts. Results are kept for 15 seconds.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: query
   *         name: hostId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The containers.
   *       400:
   *         description: hostId is missing.
   *       404:
   *         description: The host is not there, not reachable by the caller or has Docker off.
   *       502:
   *         description: The host could not be reached.
   */
  router.get("/tree", async (req: Request, res: Response) => {
    const hostId = Number(req.query.hostId);
    if (!Number.isInteger(hostId) || hostId <= 0) {
      res.status(400).json({ error: "hostId is required" });
      return;
    }
    try {
      const hosts = await ctx.hosts.list();
      if (
        !hosts.some((host) => host.id === hostId) ||
        !(await readDockerHostSettings(ctx, hostId)).enabled
      ) {
        res.status(404).json({ error: "Host not found" });
        return;
      }
      const key = `${String(ctx.currentActor() ?? "")}:${hostId}`;
      const cached = cache.get(key);
      if (cached && Date.now() - cached.at < TREE_CACHE_MS) {
        res.json({ items: cached.items });
        return;
      }
      const items = parseTreeContainers(await readContainerOutput(ctx, hostId));
      cache.set(key, { at: Date.now(), items });
      res.json({ items });
    } catch (error) {
      res
        .status(502)
        .json({ error: getErrorMessage(error, "Could not reach the host") });
    }
  });
}
