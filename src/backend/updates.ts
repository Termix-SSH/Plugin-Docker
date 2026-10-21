import type { Request, Response, Router } from "express";
import { containerCommand } from "./container-runtime.js";
import {
  CONTAINER_ID_RE,
  getErrorMessage,
  type DockerLogger,
} from "./helpers.js";
import type { DockerSession, DockerSessions } from "./sessions.js";
import { runCommand, shellQuote } from "./stacks.js";

const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,254}$/;
const PROJECT_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SERVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,126}$/;
const CACHE_MS = 30 * 60 * 1000;
const PARALLEL = 4;

export type UpdateStatus = "update" | "current" | "unknown" | "pinned";

export interface ImageUpdate {
  status: UpdateStatus;
  /** Why the check could not tell, shown as a hint. */
  reason?: string;
}

interface CacheEntry {
  at: number;
  result: ImageUpdate;
}

/** The sha256 parts of a `RepoDigests` list like ["nginx@sha256:abc"]. */
export function parseRepoDigests(output: string): string[] {
  try {
    const list = JSON.parse(output.trim()) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.split("@")[1] ?? "")
      .filter((digest) => digest.startsWith("sha256:"));
  } catch {
    return [];
  }
}

export function compareDigests(local: string[], remote: string): ImageUpdate {
  const wanted = remote.trim();
  if (!wanted.startsWith("sha256:")) {
    return { status: "unknown", reason: "registry" };
  }
  if (local.length === 0) return { status: "unknown", reason: "local" };
  return { status: local.includes(wanted) ? "current" : "update" };
}

export interface ComposeTarget {
  project: string;
  service: string;
  workingDir: string;
  configFiles: string[];
}

/** The compose project a container belongs to, from its labels. */
export function composeTargetOf(
  labels: Record<string, string> | null | undefined,
): ComposeTarget | null {
  if (!labels) return null;
  const project = labels["com.docker.compose.project"] ?? "";
  const service = labels["com.docker.compose.service"] ?? "";
  const workingDir = labels["com.docker.compose.project.working_dir"] ?? "";
  const files = (labels["com.docker.compose.project.config_files"] ?? "")
    .split(",")
    .map((file) => file.trim())
    .filter(Boolean);
  if (!PROJECT_RE.test(project) || !SERVICE_RE.test(service)) return null;
  if (!workingDir.startsWith("/")) return null;
  if (files.some((file) => !file.startsWith("/"))) return null;
  return { project, service, workingDir, configFiles: files };
}

interface Deps {
  sessions: DockerSessions;
  log: DockerLogger;
  sessionOf: (req: Request, res: Response) => DockerSession | null;
}

export function registerUpdates(
  router: Router,
  { sessions, log, sessionOf }: Deps,
) {
  const cache = new Map<string, CacheEntry>();

  const checkImage = async (
    session: DockerSession,
    image: string,
  ): Promise<ImageUpdate> => {
    if (!IMAGE_RE.test(image) || /^sha256:/.test(image)) {
      return { status: "pinned" };
    }
    if (image.includes("@")) return { status: "pinned" };
    const local = await runCommand(
      session.client,
      `${containerCommand(session.runtime, `image inspect ${shellQuote(image)} --format '{{json .RepoDigests}}'`)} 2>/dev/null`,
    );
    if (local.code !== 0) return { status: "unknown", reason: "local" };
    const remoteCommand =
      session.runtime === "podman"
        ? `skopeo inspect --format '{{.Digest}}' docker://${shellQuote(image)}`
        : containerCommand(
            session.runtime,
            `buildx imagetools inspect ${shellQuote(image)} --format '{{.Manifest.Digest}}'`,
          );
    const remote = await runCommand(
      session.client,
      `${remoteCommand} 2>/dev/null`,
    );
    if (remote.code !== 0) return { status: "unknown", reason: "registry" };
    return compareDigests(parseRepoDigests(local.output), remote.output);
  };

  /**
   * @openapi
   * /plugin-api/docker/updates/{sessionId}:
   *   get:
   *     summary: Check for image updates
   *     description: Compares the image of every container with the registry. Results are kept for 30 minutes unless refresh is set.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: refresh
   *         schema:
   *           type: boolean
   *     responses:
   *       200:
   *         description: The update status of each image.
   *       400:
   *         description: SSH session not found or not connected.
   *       500:
   *         description: Failed to check for updates.
   */
  router.get("/updates/:sessionId", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    if (session.isWindows) {
      return res.json({ checkedAt: Date.now(), images: {} });
    }
    const refresh = req.query.refresh === "true";
    try {
      const images = await sessions.run(session, async () => {
        const listed = await runCommand(
          session.client,
          `${containerCommand(session.runtime, "ps -a --format '{{.Image}}'")} 2>/dev/null`,
        );
        if (listed.code !== 0) throw new Error("Could not list containers");
        const names = [
          ...new Set(
            listed.output
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
          ),
        ];
        const result: Record<string, ImageUpdate> = {};
        const queue = [...names];
        const worker = async () => {
          for (let image = queue.shift(); image; image = queue.shift()) {
            const key = `${session.hostId}|${image}`;
            const hit = cache.get(key);
            if (hit && !refresh && Date.now() - hit.at < CACHE_MS) {
              result[image] = hit.result;
              continue;
            }
            const checked = await checkImage(session, image).catch(
              (): ImageUpdate => ({ status: "unknown", reason: "registry" }),
            );
            cache.set(key, { at: Date.now(), result: checked });
            result[image] = checked;
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(PARALLEL, names.length) }, worker),
        );
        return result;
      });
      res.json({ checkedAt: Date.now(), images });
    } catch (error) {
      log.error("Failed to check for updates", error, {
        hostId: session.hostId,
      });
      res.status(500).json({
        error: getErrorMessage(error, "Failed to check for updates"),
      });
    }
  });

  /**
   * @openapi
   * /plugin-api/docker/updates/{sessionId}/{containerId}:
   *   post:
   *     summary: Update a container
   *     description: For a compose container, pulls its image and recreates the service. For any other container, pulls the image only, so the container has to be recreated by hand.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: containerId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The image was pulled, and the service recreated when it is a compose service.
   *       400:
   *         description: SSH session not found or not connected.
   *       404:
   *         description: Container not found.
   *       500:
   *         description: The update failed.
   */
  router.post("/updates/:sessionId/:containerId", async (req, res) => {
    const session = sessionOf(req, res);
    if (!session) return;
    const containerId = String(req.params.containerId);
    if (!CONTAINER_ID_RE.test(containerId)) {
      return res.status(400).json({ error: "Invalid container ID" });
    }
    if (session.isWindows) {
      return res
        .status(400)
        .json({ error: "Updates need a Linux or macOS host" });
    }
    try {
      const outcome = await sessions.run(session, async () => {
        const inspected = await runCommand(
          session.client,
          `${containerCommand(session.runtime, `inspect ${containerId}`)} 2>&1`,
        );
        if (inspected.code !== 0) return { missing: true as const };
        const details = JSON.parse(inspected.output) as Array<{
          Config?: { Image?: string; Labels?: Record<string, string> };
        }>;
        const image = details[0]?.Config?.Image ?? "";
        const target = composeTargetOf(details[0]?.Config?.Labels);
        log.info("Docker container update", {
          hostId: session.hostId,
          containerId,
          compose: !!target,
        });

        let output = "";
        if (target) {
          const files = target.configFiles
            .map((file) => `-f ${shellQuote(file)}`)
            .join(" ");
          const base = `cd ${shellQuote(target.workingDir)} && ${containerCommand(
            session.runtime,
            `compose -p ${target.project} ${files}`.trim(),
          )}`;
          for (const step of [
            `pull ${target.service}`,
            `up -d ${target.service}`,
          ]) {
            const result = await runCommand(
              session.client,
              `${base} ${step} 2>&1`,
            );
            output += result.output;
            if (result.code !== 0) {
              throw Object.assign(new Error("Update failed"), { output });
            }
          }
        } else {
          if (!IMAGE_RE.test(image)) throw new Error("Image cannot be pulled");
          const result = await runCommand(
            session.client,
            `${containerCommand(session.runtime, `pull ${shellQuote(image)}`)} 2>&1`,
          );
          output = result.output;
          if (result.code !== 0) {
            throw Object.assign(new Error("Update failed"), { output });
          }
        }
        cache.delete(`${session.hostId}|${image}`);
        return { missing: false as const, recreated: !!target, output };
      });
      if (outcome.missing) {
        return res
          .status(404)
          .json({ error: "Container not found", code: "CONTAINER_NOT_FOUND" });
      }
      res.json({
        success: true,
        recreated: outcome.recreated,
        output: outcome.output,
      });
    } catch (error) {
      const output = (error as { output?: string }).output;
      if (output !== undefined) {
        return res
          .status(500)
          .json({ error: output.trim() || "Update failed", output });
      }
      log.error("Failed to update container", error, {
        hostId: session.hostId,
        containerId,
      });
      res.status(500).json({
        error: getErrorMessage(error, "Failed to update container"),
      });
    }
  });
}
