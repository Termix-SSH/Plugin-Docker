import type { Client, SFTPWrapper } from "ssh2";
import type { Request, Response, Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { containerCommand } from "./container-runtime.js";
import { readStacksHostSettings } from "./host-settings.js";
import { getErrorMessage, type DockerLogger } from "./helpers.js";
import type { DockerSession, DockerSessions } from "./sessions.js";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const SERVICE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,126}$/;
const COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];
const MAX_FILE_BYTES = 1024 * 1024;

const STACK_ACTIONS = [
  "deploy",
  "redeploy",
  "pull",
  "start",
  "stop",
  "restart",
  "pause",
  "unpause",
  "down",
  "destroy",
] as const;
export type StackAction = (typeof STACK_ACTIONS)[number];

const SERVICE_ACTIONS: StackAction[] = [
  "deploy",
  "pull",
  "start",
  "stop",
  "restart",
  "pause",
  "unpause",
];

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

interface CommandResult {
  code: number;
  output: string;
}

export function shellQuote(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}

/** Runs a command and keeps stdout and stderr together, whatever the exit code. */
export function runCommand(
  client: Client,
  command: string,
  stdin?: string,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err);
      let output = "";
      stream.on("data", (data: Buffer) => {
        output += data.toString();
      });
      stream.stderr.on("data", (data: Buffer) => {
        output += data.toString();
      });
      stream.on("close", (code: number | null) =>
        resolve({ code: code ?? 0, output }),
      );
      stream.on("error", reject);
      if (stdin !== undefined) stream.end(stdin);
    });
  });
}

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

function sftpRead(sftp: SFTPWrapper, path: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (statErr, stats) => {
      if (statErr) return resolve(null);
      if (stats.size > MAX_FILE_BYTES) return reject(new Error("File too big"));
      sftp.readFile(path, (err, data) =>
        err ? reject(err) : resolve(data.toString("utf8")),
      );
    });
  });
}

function sftpOp(
  run: (done: (err?: Error | null) => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    run((err) => (err ? reject(err) : resolve()));
  });
}

/** Writes through a temp file so a failed write never leaves half a file. */
async function sftpWrite(
  sftp: SFTPWrapper,
  path: string,
  content: string,
): Promise<void> {
  const tmp = `${path}.termix-tmp`;
  await sftpOp((done) => sftp.writeFile(tmp, content, done));
  try {
    await sftpOp((done) => sftp.rename(tmp, path, done));
  } catch {
    await sftpOp((done) => sftp.unlink(path, () => done()));
    await sftpOp((done) => sftp.rename(tmp, path, done));
  }
}

function sftpDirs(sftp: SFTPWrapper, path: string): Promise<string[]> {
  return new Promise((resolve) => {
    sftp.readdir(path, (err, list) => {
      if (err) return resolve([]);
      resolve(
        list
          .filter((entry) => entry.attrs.isDirectory())
          .map((entry) => entry.filename),
      );
    });
  });
}

/** `compose ps --format json` is one object per line or one array. */
export function parseJsonLines(output: string): Record<string, unknown>[] {
  const text = output.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      return JSON.parse(text) as Record<string, unknown>[];
    } catch {
      return [];
    }
  }
  return text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

export function parseServices(output: string): StackService[] {
  return parseJsonLines(output).map((row) => {
    const publishers = Array.isArray(row.Publishers)
      ? (row.Publishers as Record<string, unknown>[])
      : [];
    const ports = publishers
      .filter((p) => Number(p.PublishedPort) > 0)
      .map((p) => `${p.PublishedPort}:${p.TargetPort}`)
      .filter((value, index, all) => all.indexOf(value) === index)
      .join(", ");
    return {
      service: str(row.Service),
      name: str(row.Name),
      id: str(row.ID),
      image: str(row.Image),
      state: str(row.State),
      status: str(row.Status),
      health: str(row.Health),
      ports,
    };
  });
}

function stateOf(running: number, paused: number, total: number): StackState {
  if (total === 0) return "not-deployed";
  if (paused === total) return "paused";
  if (running === total) return "running";
  if (running > 0) return "partial";
  return "stopped";
}

/** Turns the `compose ls` status text ("running(2), exited(1)") into a state. */
export function parseStackStatus(status: string): {
  state: StackState;
  running: number;
  total: number;
} {
  let running = 0;
  let paused = 0;
  let total = 0;
  for (const part of status.split(",")) {
    const match = part.trim().match(/^([a-z]+)\((\d+)\)$/i);
    if (!match) continue;
    const count = Number(match[2]);
    total += count;
    if (match[1] === "running") running += count;
    if (match[1] === "paused") paused += count;
  }
  return { state: stateOf(running, paused, total), running, total };
}

export function stackStateFromServices(services: StackService[]) {
  const total = services.length;
  const running = services.filter((s) => s.state === "running").length;
  const paused = services.filter((s) => s.state === "paused").length;
  return { state: stateOf(running, paused, total), running, total };
}

/** The compose commands one action runs, in order. */
export function composeArgsFor(
  action: StackAction,
  service: string | undefined,
  options: { removeVolumes?: boolean },
): string[] {
  const target = service ? ` ${service}` : "";
  switch (action) {
    case "deploy":
      return [`up -d --remove-orphans${target}`];
    case "redeploy":
      return [`pull${target}`, `up -d --remove-orphans${target}`];
    case "pull":
      return [`pull${target}`];
    case "start":
    case "stop":
    case "restart":
    case "pause":
    case "unpause":
      return [`${action}${target}`];
    case "down":
      return ["down --remove-orphans"];
    case "destroy":
      return [`down --remove-orphans${options.removeVolumes ? " -v" : ""}`];
  }
}

interface Deps {
  ctx: PluginContext;
  sessions: DockerSessions;
  log: DockerLogger;
  sessionOf: (req: Request, res: Response) => DockerSession | null;
}

export function registerStacks(
  router: Router,
  { ctx, sessions, log, sessionOf }: Deps,
) {
  const adminEnabled = async () =>
    (await ctx.settings.get<boolean>("stacksEnabled")) === true;

  router.param("stackName", (_req, res, next, value) => {
    if (!NAME_RE.test(value)) {
      res.status(400).json({ error: "Invalid stack name" });
      return;
    }
    next();
  });

  /**
   * @openapi
   * /plugin-api/docker/stacks-status:
   *   get:
   *     summary: Whether stack management is on
   *     description: The admin switch for stack management. A host also has to turn it on.
   *     tags:
   *       - Docker
   *     responses:
   *       200:
   *         description: The admin switch.
   */
  router.get("/stacks-status", async (_req, res) => {
    res.json({ enabled: await adminEnabled() });
  });

  /** The caller's session when stacks are on for the admin and the host. */
  const stackSession = async (
    req: Request,
    res: Response,
  ): Promise<{ session: DockerSession; root: string } | null> => {
    if (!(await adminEnabled())) {
      res.status(403).json({
        error: "Stack management is turned off",
        code: "STACKS_DISABLED",
      });
      return null;
    }
    const session = sessionOf(req, res);
    if (!session) return null;
    const host = await readStacksHostSettings(ctx, session.hostId);
    if (!host.enabled) {
      res.status(403).json({
        error: "Stack management is turned off for this host",
        code: "STACKS_DISABLED",
      });
      return null;
    }
    if (session.isWindows) {
      res.status(400).json({
        error: "Stack management needs a Linux or macOS host",
        code: "STACKS_UNSUPPORTED",
      });
      return null;
    }
    return { session, root: host.root };
  };

  const compose = (session: DockerSession, args: string) =>
    containerCommand(session.runtime, `compose ${args}`, false);

  const fail = (
    res: Response,
    message: string,
    error: unknown,
    meta: Record<string, unknown> = {},
  ) => {
    log.error(message, error, meta);
    res.status(500).json({ error: getErrorMessage(error, message) });
  };

  /** Finds the compose file of a managed stack folder, or null. */
  const findComposeFile = async (
    sftp: SFTPWrapper,
    dir: string,
  ): Promise<{ file: string; content: string } | null> => {
    for (const file of COMPOSE_FILES) {
      const content = await sftpRead(sftp, `${dir}/${file}`);
      if (content !== null) return { file, content };
    }
    return null;
  };

  /** Runs compose inside a managed stack folder, or by project name. */
  const stackCommand = (
    session: DockerSession,
    root: string,
    name: string,
    managed: boolean,
    args: string,
  ) => {
    const run = `${compose(session, `-p ${name} ${args}`)} 2>&1`;
    return managed ? `cd ${shellQuote(`${root}/${name}`)} && ${run}` : run;
  };

  /** Whether a stack folder with a compose file exists. */
  const isManaged = async (session: DockerSession, dir: string) => {
    const sftp = await getSftp(session.client);
    try {
      return (await findComposeFile(sftp, dir)) !== null;
    } finally {
      sftp.end();
    }
  };

  const loadProjects = async (session: DockerSession) => {
    const result = await runCommand(
      session.client,
      compose(session, "ls -a --format json") + " 2>&1",
    );
    if (result.code !== 0) {
      throw new Error(result.output.trim() || "Compose is not available");
    }
    return parseJsonLines(result.output);
  };

  /**
   * @openapi
   * /plugin-api/docker/stacks/{sessionId}:
   *   get:
   *     summary: List stacks
   *     description: Stacks in the host's stacks folder plus any other compose project that exists on the host.
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
   *         description: The stacks.
   *       400:
   *         description: Session not found or the host is not supported.
   *       403:
   *         description: Stack management is off.
   *       500:
   *         description: Failed to list stacks.
   */
  router.get("/stacks/:sessionId", async (req, res) => {
    const found = await stackSession(req, res);
    if (!found) return;
    const { session, root } = found;
    try {
      const stacks = await sessions.run(session, async () => {
        const projects = await loadProjects(session);
        const sftp = await getSftp(session.client);
        const byName = new Map<string, StackSummary>();
        try {
          for (const dir of await sftpDirs(sftp, root)) {
            if (!NAME_RE.test(dir)) continue;
            const composeFile = await findComposeFile(sftp, `${root}/${dir}`);
            if (!composeFile) continue;
            byName.set(dir, {
              name: dir,
              managed: true,
              state: "not-deployed",
              running: 0,
              total: 0,
              composeFile: composeFile.file,
            });
          }
        } finally {
          sftp.end();
        }
        for (const project of projects) {
          const name = str(project.Name);
          if (!NAME_RE.test(name)) continue;
          const status = parseStackStatus(str(project.Status));
          const existing = byName.get(name);
          if (existing) Object.assign(existing, status);
          else
            byName.set(name, {
              name,
              managed: false,
              ...status,
              composeFile: str(project.ConfigFiles).split(",")[0] || null,
            });
        }
        return [...byName.values()].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      });
      res.json({ root, stacks });
    } catch (error) {
      fail(res, "Failed to list stacks", error, { hostId: session.hostId });
    }
  });

  /**
   * @openapi
   * /plugin-api/docker/stacks/{sessionId}:
   *   post:
   *     summary: Create a stack
   *     description: Makes a folder in the stacks folder with a compose file and an optional env file.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - name
   *               - compose
   *             properties:
   *               name:
   *                 type: string
   *               compose:
   *                 type: string
   *               env:
   *                 type: string
   *     responses:
   *       200:
   *         description: Stack created.
   *       400:
   *         description: Invalid name or content.
   *       403:
   *         description: Stack management is off.
   *       409:
   *         description: A stack with this name exists.
   *       500:
   *         description: Failed to create the stack.
   */
  router.post("/stacks/:sessionId", async (req, res) => {
    const found = await stackSession(req, res);
    if (!found) return;
    const { session, root } = found;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = str(body.name);
    const composeText = str(body.compose);
    const envText = str(body.env);
    if (!NAME_RE.test(name)) {
      return res.status(400).json({ error: "Invalid stack name" });
    }
    if (!composeText.trim() || composeText.length > MAX_FILE_BYTES) {
      return res
        .status(400)
        .json({ error: "Compose file is empty or too big" });
    }
    const dir = `${root}/${name}`;
    try {
      await sessions.run(session, async () => {
        const made = await runCommand(
          session.client,
          `mkdir -p ${shellQuote(root)} && mkdir ${shellQuote(dir)} 2>&1`,
        );
        if (made.code !== 0) {
          throw Object.assign(new Error("A stack with this name exists"), {
            status: 409,
          });
        }
        const sftp = await getSftp(session.client);
        try {
          await sftpWrite(sftp, `${dir}/compose.yaml`, composeText);
          if (envText) await sftpWrite(sftp, `${dir}/.env`, envText);
        } finally {
          sftp.end();
        }
      });
      log.info("Docker stack created", { hostId: session.hostId, name });
      res.json({ success: true, name });
    } catch (error) {
      if ((error as { status?: number }).status === 409) {
        return res.status(409).json({ error: getErrorMessage(error) });
      }
      fail(res, "Failed to create the stack", error, { name });
    }
  });

  /**
   * @openapi
   * /plugin-api/docker/stacks/{sessionId}/{stackName}:
   *   get:
   *     summary: Get a stack
   *     description: The compose file, env file and services of a stack.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: stackName
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: The stack.
   *       403:
   *         description: Stack management is off.
   *       404:
   *         description: Stack not found.
   *       500:
   *         description: Failed to load the stack.
   */
  router.get("/stacks/:sessionId/:stackName", async (req, res) => {
    const found = await stackSession(req, res);
    if (!found) return;
    const { session, root } = found;
    const name = String(req.params.stackName);
    try {
      const data = await sessions.run(session, async () => {
        const sftp = await getSftp(session.client);
        let files: { file: string; content: string } | null;
        let env: string | null = null;
        try {
          files = await findComposeFile(sftp, `${root}/${name}`);
          if (files) env = await sftpRead(sftp, `${root}/${name}/.env`);
        } finally {
          sftp.end();
        }
        const managed = files !== null;
        const ps = await runCommand(
          session.client,
          stackCommand(session, root, name, managed, "ps -a --format json"),
        );
        const services = ps.code === 0 ? parseServices(ps.output) : [];
        const declared = managed
          ? await runCommand(
              session.client,
              stackCommand(session, root, name, true, "config --services"),
            )
          : { code: 1, output: "" };
        return { files, env, services, declared, managed };
      });
      if (!data.managed && data.services.length === 0) {
        return res.status(404).json({ error: "Stack not found" });
      }
      const declaredServices =
        data.declared.code === 0
          ? data.declared.output
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => SERVICE_RE.test(line))
          : [];
      res.json({
        name,
        managed: data.managed,
        composeFile: data.files?.file ?? null,
        compose: data.files?.content ?? null,
        env: data.env,
        declaredServices,
        services: data.services,
        ...stackStateFromServices(data.services),
      });
    } catch (error) {
      fail(res, "Failed to load the stack", error, { name });
    }
  });

  const saveFile =
    (kind: "compose" | "env") => async (req: Request, res: Response) => {
      const found = await stackSession(req, res);
      if (!found) return;
      const { session, root } = found;
      const name = String(req.params.stackName);
      const content = str((req.body as Record<string, unknown>)?.content);
      if (content.length > MAX_FILE_BYTES) {
        return res.status(400).json({ error: "File is too big" });
      }
      if (kind === "compose" && !content.trim()) {
        return res.status(400).json({ error: "Compose file is empty" });
      }
      try {
        await sessions.run(session, async () => {
          const sftp = await getSftp(session.client);
          try {
            const dir = `${root}/${name}`;
            const existing = await findComposeFile(sftp, dir);
            if (!existing) {
              throw Object.assign(new Error("Stack not found"), {
                status: 404,
              });
            }
            const target =
              kind === "compose" ? `${dir}/${existing.file}` : `${dir}/.env`;
            await sftpWrite(sftp, target, content);
          } finally {
            sftp.end();
          }
        });
        log.info("Docker stack file saved", {
          hostId: session.hostId,
          name,
          kind,
        });
        res.json({ success: true });
      } catch (error) {
        if ((error as { status?: number }).status === 404) {
          return res.status(404).json({ error: "Stack not found" });
        }
        fail(res, "Failed to save the file", error, { name, kind });
      }
    };

  /**
   * @openapi
   * /plugin-api/docker/stacks/{sessionId}/{stackName}/compose:
   *   put:
   *     summary: Save the compose file
   *     description: Replaces the compose file of a stack in the stacks folder.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: stackName
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - content
   *             properties:
   *               content:
   *                 type: string
   *     responses:
   *       200:
   *         description: Saved.
   *       403:
   *         description: Stack management is off.
   *       404:
   *         description: Stack not found.
   *       500:
   *         description: Failed to save.
   */
  router.put("/stacks/:sessionId/:stackName/compose", saveFile("compose"));

  /**
   * @openapi
   * /plugin-api/docker/stacks/{sessionId}/{stackName}/env:
   *   put:
   *     summary: Save the env file
   *     description: Replaces the .env file of a stack in the stacks folder.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: stackName
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - content
   *             properties:
   *               content:
   *                 type: string
   *     responses:
   *       200:
   *         description: Saved.
   *       403:
   *         description: Stack management is off.
   *       404:
   *         description: Stack not found.
   *       500:
   *         description: Failed to save.
   */
  router.put("/stacks/:sessionId/:stackName/env", saveFile("env"));

  /**
   * @openapi
   * /plugin-api/docker/stacks/{sessionId}/validate:
   *   post:
   *     summary: Check a compose file
   *     description: Runs compose config on the given text and returns any errors.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - compose
   *             properties:
   *               compose:
   *                 type: string
   *               name:
   *                 type: string
   *     responses:
   *       200:
   *         description: Whether the file is valid, with the output.
   *       400:
   *         description: The file is too big.
   *       403:
   *         description: Stack management is off.
   *       500:
   *         description: Failed to check the file.
   */
  router.post("/stacks/:sessionId/validate", async (req, res) => {
    const found = await stackSession(req, res);
    if (!found) return;
    const { session, root } = found;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const composeText = str(body.compose);
    const name = str(body.name);
    if (composeText.length > MAX_FILE_BYTES) {
      return res.status(400).json({ error: "File is too big" });
    }
    const dir = NAME_RE.test(name) ? `${root}/${name}` : "/tmp";
    try {
      const result = await sessions.run(session, () =>
        runCommand(
          session.client,
          `${compose(session, `--project-directory ${shellQuote(dir)} -f - config -q`)} 2>&1`,
          composeText,
        ),
      );
      res.json({ valid: result.code === 0, output: result.output.trim() });
    } catch (error) {
      fail(res, "Failed to check the file", error);
    }
  });

  /**
   * @openapi
   * /plugin-api/docker/stacks/{sessionId}/{stackName}/action:
   *   post:
   *     summary: Run a stack action
   *     description: Deploy, redeploy, pull, start, stop, restart, pause, unpause, down or destroy a stack, or run most of them on one service.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: stackName
   *         required: true
   *         schema:
   *           type: string
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - action
   *             properties:
   *               action:
   *                 type: string
   *               service:
   *                 type: string
   *               removeVolumes:
   *                 type: boolean
   *               removeFiles:
   *                 type: boolean
   *     responses:
   *       200:
   *         description: The action ran, with its output.
   *       400:
   *         description: Invalid action or service.
   *       403:
   *         description: Stack management is off.
   *       500:
   *         description: The action failed.
   */
  router.post("/stacks/:sessionId/:stackName/action", async (req, res) => {
    const found = await stackSession(req, res);
    if (!found) return;
    const { session, root } = found;
    const name = String(req.params.stackName);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = str(body.action) as StackAction;
    const service = str(body.service) || undefined;
    if (!STACK_ACTIONS.includes(action)) {
      return res.status(400).json({ error: "Invalid action" });
    }
    if (
      service &&
      (!SERVICE_RE.test(service) || !SERVICE_ACTIONS.includes(action))
    ) {
      return res.status(400).json({ error: "Invalid service action" });
    }
    try {
      const output = await sessions.run(session, async () => {
        const managed = await isManaged(session, `${root}/${name}`);
        log.info("Docker stack operation", {
          hostId: session.hostId,
          name,
          action,
          service,
        });
        let out = "";
        for (const args of composeArgsFor(action, service, {
          removeVolumes: body.removeVolumes === true,
        })) {
          const result = await runCommand(
            session.client,
            stackCommand(session, root, name, managed, args),
          );
          out += result.output;
          if (result.code !== 0) {
            throw Object.assign(new Error("Action failed"), { output: out });
          }
        }
        if (action === "destroy" && managed && body.removeFiles === true) {
          await runCommand(
            session.client,
            `rm -rf -- ${shellQuote(`${root}/${name}`)}`,
          );
        }
        return out;
      });
      res.json({ success: true, output });
    } catch (error) {
      const output = (error as { output?: string }).output;
      if (output !== undefined) {
        log.warn("Docker stack action failed", { name, action });
        return res
          .status(500)
          .json({ error: output.trim() || "Action failed", output });
      }
      fail(res, "Stack action failed", error, { name, action });
    }
  });

  /**
   * @openapi
   * /plugin-api/docker/stacks/{sessionId}/{stackName}/logs:
   *   get:
   *     summary: Get stack logs
   *     description: The recent logs of a whole stack or one service.
   *     tags:
   *       - Docker
   *     parameters:
   *       - in: path
   *         name: sessionId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: stackName
   *         required: true
   *         schema:
   *           type: string
   *       - in: query
   *         name: service
   *         schema:
   *           type: string
   *       - in: query
   *         name: tail
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: The logs.
   *       400:
   *         description: Invalid service.
   *       403:
   *         description: Stack management is off.
   *       500:
   *         description: Failed to load logs.
   */
  router.get("/stacks/:sessionId/:stackName/logs", async (req, res) => {
    const found = await stackSession(req, res);
    if (!found) return;
    const { session, root } = found;
    const name = String(req.params.stackName);
    const service =
      typeof req.query.service === "string" ? req.query.service : "";
    if (service && !SERVICE_RE.test(service)) {
      return res.status(400).json({ error: "Invalid service" });
    }
    const tail = Math.min(
      Math.max(Math.floor(Number(req.query.tail)) || 500, 1),
      5000,
    );
    try {
      const logs = await sessions.run(session, async () => {
        const managed = await isManaged(session, `${root}/${name}`);
        const result = await runCommand(
          session.client,
          stackCommand(
            session,
            root,
            name,
            managed,
            `logs --no-color --timestamps --tail ${tail}${service ? ` ${service}` : ""}`,
          ),
        );
        return result.output;
      });
      res.json({ success: true, logs });
    } catch (error) {
      fail(res, "Failed to load logs", error, { name });
    }
  });
}
