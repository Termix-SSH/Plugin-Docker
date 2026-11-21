import type { Request, Response, Router } from "express";
import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import { containerCommand } from "./container-runtime.js";
import type { DockerSession, DockerSessions } from "./sessions.js";
import {
  CONTAINER_ID_RE,
  getErrorMessage,
  type DockerLogger,
} from "./helpers.js";

/** Volume and network names, and image ids. */
export const NAME_RE = CONTAINER_ID_RE;
/** An image reference like nginx:1.27, ghcr.io/a/b@sha256:..., or an id. */
export const IMAGE_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,254}$/;
const SUBNET_RE = /^[0-9a-fA-F:.]+\/\d{1,3}$/;
export const NETWORK_DRIVERS = ["bridge", "overlay", "macvlan", "ipvlan"];

// Tab separated so both Docker and Podman fill it the same way.
const IMAGE_FORMAT =
  '"{{.ID}}\\t{{.Repository}}\\t{{.Tag}}\\t{{.Size}}\\t{{.CreatedSince}}"';
const VOLUME_FORMAT = '"{{.Name}}\\t{{.Driver}}\\t{{.Mountpoint}}"';
const NETWORK_FORMAT = '"{{.ID}}\\t{{.Name}}\\t{{.Driver}}"';
const CONTAINER_IMAGE_FORMAT = '"{{.Image}}"';

export interface ImageRow {
  id: string;
  repository: string;
  tag: string;
  size: string;
  created: string;
  inUse: boolean;
}

export interface VolumeRow {
  name: string;
  driver: string;
  mountpoint: string;
  inUse: boolean;
}

export interface NetworkRow {
  id: string;
  name: string;
  driver: string;
  builtIn: boolean;
}

export const resourceArgs = {
  images: () => `image ls --format ${IMAGE_FORMAT}`,
  containerImages: () => `ps -a --format ${CONTAINER_IMAGE_FORMAT}`,
  volumes: () => `volume ls --format ${VOLUME_FORMAT}`,
  danglingVolumes: () =>
    `volume ls --filter dangling=true --format "{{.Name}}"`,
  networks: () => `network ls --format ${NETWORK_FORMAT}`,
  inspectImage: (ref: string) => `image inspect ${requireImage(ref)}`,
  inspectVolume: (name: string) => `volume inspect ${requireName(name)}`,
  inspectNetwork: (name: string) => `network inspect ${requireName(name)}`,
  pullImage: (ref: string) => `pull ${requireImage(ref)}`,
  removeImage: (ref: string, force: boolean) =>
    `image rm ${force ? "-f " : ""}${requireImage(ref)}`,
  pruneImages: (all: boolean) => `image prune -f${all ? " -a" : ""}`,
  createVolume: (name: string) => `volume create ${requireName(name)}`,
  removeVolume: (name: string) => `volume rm ${requireName(name)}`,
  pruneVolumes: (all: boolean) => `volume prune -f${all ? " -a" : ""}`,
  createNetwork: (name: string, driver: string, subnet: string) => {
    if (!NETWORK_DRIVERS.includes(driver)) {
      throw new Error("Unknown network driver");
    }
    if (subnet && !SUBNET_RE.test(subnet)) {
      throw new Error("Subnet must look like 10.10.0.0/24");
    }
    return `network create --driver ${driver}${subnet ? ` --subnet ${subnet}` : ""} ${requireName(name)}`;
  },
  removeNetwork: (name: string) => `network rm ${requireName(name)}`,
  pruneNetworks: () => "network prune -f",
};

function requireName(value: unknown): string {
  if (typeof value !== "string" || value.length > 255 || !NAME_RE.test(value)) {
    throw new Error("That is not a valid name");
  }
  return value;
}

function requireImage(value: unknown): string {
  if (typeof value !== "string" || !IMAGE_REF_RE.test(value)) {
    throw new Error("That is not a valid image");
  }
  return value;
}

function lines(output: string): string[][] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

/** Image rows, marked in use when a container was made from them. */
export function parseImages(
  output: string,
  containerImages: string,
): ImageRow[] {
  const used = new Set(
    containerImages
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return lines(output).map(
    ([id = "", repository = "", tag = "", size = "", created = ""]) => {
      const ref = `${repository}:${tag}`;
      const inUse =
        used.has(ref) ||
        (tag === "latest" && used.has(repository)) ||
        [...used].some(
          (image) =>
            image.length >= 12 &&
            (id.startsWith(image) ||
              image.replace(/^sha256:/, "").startsWith(id)),
        );
      return { id, repository, tag, size, created, inUse };
    },
  );
}

export function parseVolumes(output: string, dangling: string): VolumeRow[] {
  const unused = new Set(
    dangling
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return lines(output).map(([name = "", driver = "", mountpoint = ""]) => ({
    name,
    driver,
    mountpoint,
    inUse: !unused.has(name),
  }));
}

// Networks the runtime makes itself and won't remove.
const BUILT_IN_NETWORKS = new Set(["bridge", "host", "none", "podman"]);

export function parseNetworks(output: string): NetworkRow[] {
  return lines(output).map(([id = "", name = "", driver = ""]) => ({
    id,
    name,
    driver,
    builtIn: BUILT_IN_NETWORKS.has(name),
  }));
}

/** The last line of a prune, like "Total reclaimed space: 1.2GB". */
export function reclaimed(output: string): string {
  const match = /Total reclaimed space:\s*(.+)/i.exec(output);
  return match ? match[1].trim() : "";
}

type Exec = (
  hostId: number,
  args: string | ((isWindows: boolean) => string),
) => Promise<string>;

function requireHost(context: PluginOperationContext): number {
  if (context.hostId === undefined) throw new Error("This needs a host");
  return context.hostId;
}

const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

/** The actions behind the images, volumes and networks views. */
export function registerResourceOperations(
  ctx: PluginContext,
  exec: Exec,
): void {
  ctx.operations.register("docker.pull-image", {
    describe: (input) => `Would pull ${requireImage(text(input.image))}`,
    run: async (input, context) => {
      const image = requireImage(text(input.image));
      await exec(requireHost(context), resourceArgs.pullImage(image));
      return { summary: `Pulled ${image}`, changed: true };
    },
  });

  ctx.operations.register("docker.remove-image", {
    describe: (input) =>
      `Would remove image ${requireImage(text(input.image))}${input.force ? " by force" : ""}`,
    run: async (input, context) => {
      const image = requireImage(text(input.image));
      await exec(
        requireHost(context),
        resourceArgs.removeImage(image, input.force === true),
      );
      return { summary: `Removed image ${image}`, changed: true };
    },
  });

  ctx.operations.register("docker.prune-images", {
    describe: (input) =>
      input.all === true
        ? "Would remove every image no container uses"
        : "Would remove dangling images",
    run: async (input, context) => {
      const output = await exec(
        requireHost(context),
        resourceArgs.pruneImages(input.all === true),
      );
      const space = reclaimed(output);
      return {
        summary: space ? `Freed ${space}` : "Removed unused images",
        changed: true,
        data: { reclaimed: space },
      };
    },
  });

  ctx.operations.register("docker.create-volume", {
    describe: (input) => `Would create volume ${requireName(text(input.name))}`,
    run: async (input, context) => {
      const name = requireName(text(input.name));
      await exec(requireHost(context), resourceArgs.createVolume(name));
      return { summary: `Created volume ${name}`, changed: true };
    },
  });

  ctx.operations.register("docker.remove-volume", {
    describe: (input) => `Would remove volume ${requireName(text(input.name))}`,
    run: async (input, context) => {
      const name = requireName(text(input.name));
      await exec(requireHost(context), resourceArgs.removeVolume(name));
      return { summary: `Removed volume ${name}`, changed: true };
    },
  });

  ctx.operations.register("docker.prune-volumes", {
    describe: () => "Would remove every volume no container uses",
    run: async (_input, context) => {
      const hostId = requireHost(context);
      let output: string;
      try {
        // Docker 23 and later only prune anonymous volumes without -a.
        output = await exec(hostId, resourceArgs.pruneVolumes(true));
      } catch (error) {
        if (!/unknown (shorthand )?flag/i.test(getErrorMessage(error, ""))) {
          throw error;
        }
        output = await exec(hostId, resourceArgs.pruneVolumes(false));
      }
      const space = reclaimed(output);
      return {
        summary: space ? `Freed ${space}` : "Removed unused volumes",
        changed: true,
        data: { reclaimed: space },
      };
    },
  });

  ctx.operations.register("docker.create-network", {
    describe: (input) =>
      `Would create network ${requireName(text(input.name))}`,
    run: async (input, context) => {
      const name = requireName(text(input.name));
      await exec(
        requireHost(context),
        resourceArgs.createNetwork(
          name,
          text(input.driver) || "bridge",
          text(input.subnet),
        ),
      );
      return { summary: `Created network ${name}`, changed: true };
    },
  });

  ctx.operations.register("docker.remove-network", {
    describe: (input) =>
      `Would remove network ${requireName(text(input.name))}`,
    run: async (input, context) => {
      const name = requireName(text(input.name));
      await exec(requireHost(context), resourceArgs.removeNetwork(name));
      return { summary: `Removed network ${name}`, changed: true };
    },
  });

  ctx.operations.register("docker.prune-networks", {
    describe: () => "Would remove every network no container uses",
    run: async (_input, context) => {
      await exec(requireHost(context), resourceArgs.pruneNetworks());
      return { summary: "Removed unused networks", changed: true };
    },
  });
}

interface RouteDeps {
  ctx: PluginContext;
  sessions: DockerSessions;
  log: DockerLogger;
  sessionOf: (req: Request, res: Response) => DockerSession | null;
  refused: (error: unknown, res: Response) => boolean;
}

/** The write actions a route may start, and the input each one takes. */
const WRITE_ACTIONS: Record<string, string> = {
  "pull-image": "docker.pull-image",
  "remove-image": "docker.remove-image",
  "prune-images": "docker.prune-images",
  "create-volume": "docker.create-volume",
  "remove-volume": "docker.remove-volume",
  "prune-volumes": "docker.prune-volumes",
  "create-network": "docker.create-network",
  "remove-network": "docker.remove-network",
  "prune-networks": "docker.prune-networks",
};

function pickInput(body: unknown): Record<string, unknown> {
  const source =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of ["image", "name", "driver", "subnet"]) {
    if (typeof source[key] === "string") out[key] = source[key];
  }
  for (const key of ["force", "all"]) {
    if (source[key] === true) out[key] = true;
  }
  return out;
}

export function registerResourceRoutes(
  router: Router,
  { ctx, sessions, log, sessionOf, refused }: RouteDeps,
): void {
  const run = (session: DockerSession, args: string) =>
    sessions.run(session, () =>
      sessions.exec(
        session,
        containerCommand(session.runtime, args, session.isWindows),
      ),
    );

  const list =
    (what: string, read: (session: DockerSession) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      const session = sessionOf(req, res);
      if (!session) return;
      try {
        res.json(await read(session));
      } catch (error) {
        log.error(`Failed to list Docker ${what}`, error, {
          hostId: session.hostId,
        });
        res.status(500).json({ error: `Failed to list ${what}` });
      }
    };

  /**
   * @openapi
   * /plugin-api/docker/images/{sessionId}:
   *   get:
   *     summary: List images
   *     description: Images on the session's host, marked in use when a container was made from them.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Image rows.
   *       400:
   *         description: SSH session not found or not connected.
   *       500:
   *         description: Failed to list images.
   */
  router.get(
    "/images/:sessionId",
    list("images", async (session) => {
      const [images, used] = await Promise.all([
        run(session, resourceArgs.images()),
        run(session, resourceArgs.containerImages()),
      ]);
      return parseImages(images, used);
    }),
  );

  /**
   * @openapi
   * /plugin-api/docker/volumes/{sessionId}:
   *   get:
   *     summary: List volumes
   *     description: Volumes on the session's host, marked in use unless no container uses them.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Volume rows.
   *       400:
   *         description: SSH session not found or not connected.
   *       500:
   *         description: Failed to list volumes.
   */
  router.get(
    "/volumes/:sessionId",
    list("volumes", async (session) => {
      const [volumes, dangling] = await Promise.all([
        run(session, resourceArgs.volumes()),
        run(session, resourceArgs.danglingVolumes()),
      ]);
      return parseVolumes(volumes, dangling);
    }),
  );

  /**
   * @openapi
   * /plugin-api/docker/networks/{sessionId}:
   *   get:
   *     summary: List networks
   *     description: Networks on the session's host.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Network rows.
   *       400:
   *         description: SSH session not found or not connected.
   *       500:
   *         description: Failed to list networks.
   */
  router.get(
    "/networks/:sessionId",
    list("networks", async (session) =>
      parseNetworks(await run(session, resourceArgs.networks())),
    ),
  );

  /**
   * @openapi
   * /plugin-api/docker/inspect/{sessionId}/{kind}:
   *   get:
   *     summary: Inspect an image, volume or network
   *     description: The runtime's inspect output for one image, volume or network.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: kind
   *         required: true
   *         schema:
   *           type: string
   *           enum: [image, volume, network]
   *       - in: query
   *         name: name
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The inspect output.
   *       400:
   *         description: Bad name, or SSH session not found.
   *       404:
   *         description: Not found.
   */
  router.get("/inspect/:sessionId/:kind", async (req, res) => {
    const kind = req.params.kind;
    const name = typeof req.query.name === "string" ? req.query.name : "";
    let args: string;
    try {
      if (kind === "image") args = resourceArgs.inspectImage(name);
      else if (kind === "volume") args = resourceArgs.inspectVolume(name);
      else if (kind === "network") args = resourceArgs.inspectNetwork(name);
      else return res.status(404).json({ error: "Unknown kind" });
    } catch (error) {
      return res
        .status(400)
        .json({ error: getErrorMessage(error, "Bad name") });
    }
    const session = sessionOf(req, res);
    if (!session) return;
    try {
      const parsed = JSON.parse(await run(session, args)) as unknown[];
      if (!Array.isArray(parsed) || parsed.length === 0) {
        return res.status(404).json({ error: "Not found" });
      }
      res.json(parsed[0]);
    } catch {
      res.status(404).json({ error: "Not found" });
    }
  });

  /**
   * @openapi
   * /plugin-api/docker/resources/{sessionId}/{action}:
   *   post:
   *     summary: Change images, volumes or networks
   *     description: Pulls, removes or prunes images, and creates, removes or prunes volumes and networks. Runs as an operation, so it needs edit access to the host and lands in run history.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: action
   *         required: true
   *         schema:
   *           type: string
   *           enum: [pull-image, remove-image, prune-images, create-volume, remove-volume, prune-volumes, create-network, remove-network, prune-networks]
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               image:
   *                 type: string
   *               name:
   *                 type: string
   *               driver:
   *                 type: string
   *               subnet:
   *                 type: string
   *               force:
   *                 type: boolean
   *               all:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: The action ran.
   *       400:
   *         description: SSH session not found.
   *       403:
   *         description: Not allowed on this host.
   *       404:
   *         description: Unknown action.
   *       422:
   *         description: The runtime refused or the action failed.
   */
  router.post("/resources/:sessionId/:action", async (req, res) => {
    const actionId = WRITE_ACTIONS[req.params.action];
    if (!actionId) return res.status(404).json({ error: "Unknown action" });
    const session = sessionOf(req, res);
    if (!session) return;
    try {
      const outcome = await ctx.operations.run(actionId, {
        hostId: session.hostId,
        input: pickInput(req.body),
        confirmed: true,
      });
      if (outcome.status !== "success") {
        throw new Error(outcome.error ?? outcome.status);
      }
      res.json({ success: true, message: outcome.summary ?? "" });
    } catch (error) {
      if (refused(error, res)) return;
      log.error(`Docker ${req.params.action} failed`, error, {
        hostId: session.hostId,
      });
      // The runtime's own reason, like an image still in use.
      res.status(422).json({
        success: false,
        error: getErrorMessage(error, "The action failed"),
      });
    }
  });
}
