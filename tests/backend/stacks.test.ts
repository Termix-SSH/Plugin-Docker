import { afterEach, describe, expect, it } from "vitest";
import {
  composeArgsFor,
  parseJsonLines,
  parseServices,
  parseStackStatus,
  shellQuote,
  stackStateFromServices,
} from "../../src/backend/stacks";
import { FakeClient } from "./fake-ssh";
import { dockerClient, startServer, type TestServer } from "./server";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

/** An in-memory sftp over a path to text map; folders are the keys' parents. */
function fakeSftp(files: Map<string, string>) {
  const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/"));
  return {
    stat(path: string, cb: (err: Error | null, stats?: unknown) => void) {
      const data = files.get(path);
      if (data === undefined) return cb(new Error("No such file"));
      cb(null, { size: data.length });
    },
    readFile(path: string, cb: (err: Error | null, data?: Buffer) => void) {
      cb(null, Buffer.from(files.get(path) ?? ""));
    },
    writeFile(path: string, data: string, cb: (err?: Error | null) => void) {
      files.set(path, data);
      cb();
    },
    rename(from: string, to: string, cb: (err?: Error | null) => void) {
      files.set(to, files.get(from) ?? "");
      files.delete(from);
      cb();
    },
    unlink(path: string, cb: (err?: Error | null) => void) {
      files.delete(path);
      cb();
    },
    readdir(path: string, cb: (err: Error | null, list?: unknown[]) => void) {
      const dirs = new Set<string>();
      for (const file of files.keys()) {
        if (dirOf(dirOf(file)) === path)
          dirs.add(dirOf(file).split("/").pop()!);
      }
      cb(
        null,
        [...dirs].map((filename) => ({
          filename,
          attrs: { isDirectory: () => true },
        })),
      );
    },
    end() {},
  };
}

function stackClient(files: Map<string, string>): FakeClient {
  const client = dockerClient();
  (client as unknown as { sftp: unknown }).sftp = (
    cb: (err: Error | undefined, sftp: unknown) => void,
  ) => cb(undefined, fakeSftp(files));
  client.reply(/compose ls -a/, {
    stdout:
      '[{"Name":"web","Status":"running(2)","ConfigFiles":"/x/compose.yaml"}]',
  });
  client.reply(/mkdir -p/, { stdout: "" });
  client.reply(/ps -a --format json/, {
    stdout:
      '{"Service":"app","Name":"web-app-1","ID":"c1","Image":"nginx","State":"running","Status":"Up","Health":"","Publishers":[{"PublishedPort":8080,"TargetPort":80}]}\n',
  });
  client.reply(/config --services/, { stdout: "app\n" });
  client.reply(/ up -d/, { stdout: "started" });
  client.reply(/ pull/, { stdout: "pulled" });
  client.reply(/ logs /, { stdout: "app-1  | hello\n" });
  client.reply(/config -q/, { stdout: "" });
  return client;
}

async function ready(
  files: Map<string, string>,
  options: { admin?: boolean; host?: boolean } = {},
) {
  server = await startServer({
    client: stackClient(files),
    mock: { settings: { stacksEnabled: options.admin ?? true } },
  });
  if (options.host !== false) {
    await server.mock.ctx.settings.setHost(7, "enableStacks", true);
  }
  await server.request("POST", "/ssh/connect", {
    body: { sessionId: "s1", hostId: 7 },
  });
  return server;
}

describe("stack helpers", () => {
  it("quotes single quotes for the shell", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it("reads json lines and arrays", () => {
    expect(parseJsonLines('{"a":1}\n{"a":2}\nnope')).toHaveLength(2);
    expect(parseJsonLines('[{"a":1},{"a":2}]')).toHaveLength(2);
    expect(parseJsonLines("")).toEqual([]);
  });

  it("turns compose ls status text into a state", () => {
    expect(parseStackStatus("running(2)").state).toBe("running");
    expect(parseStackStatus("running(1), exited(1)")).toMatchObject({
      state: "partial",
      running: 1,
      total: 2,
    });
    expect(parseStackStatus("exited(2)").state).toBe("stopped");
    expect(parseStackStatus("paused(1)").state).toBe("paused");
    expect(parseStackStatus("").state).toBe("not-deployed");
  });

  it("reads services and their published ports", () => {
    const services = parseServices(
      '{"Service":"app","Name":"n","ID":"i","Image":"nginx","State":"running","Status":"Up","Publishers":[{"PublishedPort":8080,"TargetPort":80},{"PublishedPort":8080,"TargetPort":80}]}',
    );
    expect(services[0].ports).toBe("8080:80");
    expect(stackStateFromServices(services).state).toBe("running");
    expect(stackStateFromServices([]).state).toBe("not-deployed");
  });

  it("builds the compose commands for each action", () => {
    expect(composeArgsFor("redeploy", undefined, {})).toEqual([
      "pull",
      "up -d --remove-orphans",
    ]);
    expect(composeArgsFor("restart", "app", {})).toEqual(["restart app"]);
    expect(
      composeArgsFor("destroy", undefined, { removeVolumes: true }),
    ).toEqual(["down --remove-orphans -v"]);
  });
});

describe("stack routes", () => {
  it("reports the admin switch and keeps it off by default", async () => {
    server = await startServer();
    const status = await server.request("GET", "/stacks-status");
    expect(status.body).toEqual({ enabled: false });
  });

  it("blocks every stack route while the admin switch is off", async () => {
    await ready(new Map(), { admin: false });
    const list = await server!.request("GET", "/stacks/s1");
    expect(list.status).toBe(403);
    expect(list.body.code).toBe("STACKS_DISABLED");
  });

  it("blocks stack routes on a host that did not turn them on", async () => {
    await ready(new Map(), { host: false });
    const list = await server!.request("GET", "/stacks/s1");
    expect(list.status).toBe(403);
  });

  it("lists stack folders and outside projects", async () => {
    const files = new Map([["/opt/stacks/blog/compose.yaml", "services: {}"]]);
    await ready(files);
    const list = await server!.request("GET", "/stacks/s1");
    expect(list.status).toBe(200);
    const byName = Object.fromEntries(
      list.body.stacks.map((s: { name: string }) => [s.name, s]),
    );
    expect(byName.blog).toMatchObject({ managed: true, state: "not-deployed" });
    expect(byName.web).toMatchObject({ managed: false, state: "running" });
  });

  it("creates a stack and rejects bad names", async () => {
    const files = new Map<string, string>();
    await ready(files);
    const bad = await server!.request("POST", "/stacks/s1", {
      body: { name: "../evil", compose: "services: {}" },
    });
    expect(bad.status).toBe(400);
    const made = await server!.request("POST", "/stacks/s1", {
      body: { name: "blog", compose: "services: {}", env: "A=1" },
    });
    expect(made.status).toBe(200);
    expect(files.get("/opt/stacks/blog/compose.yaml")).toBe("services: {}");
    expect(files.get("/opt/stacks/blog/.env")).toBe("A=1");
  });

  it("rejects a stack name that is not a valid path part", async () => {
    await ready(new Map());
    const res = await server!.request("GET", "/stacks/s1/..%2Fetc");
    expect(res.status).toBe(400);
  });

  it("loads a stack with its files and services", async () => {
    const files = new Map([
      ["/opt/stacks/blog/compose.yaml", "services:\n  app: {}"],
      ["/opt/stacks/blog/.env", "A=1\n"],
    ]);
    await ready(files);
    const res = await server!.request("GET", "/stacks/s1/blog");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      managed: true,
      compose: "services:\n  app: {}",
      env: "A=1\n",
      declaredServices: ["app"],
      state: "running",
    });
  });

  it("saves the compose and env files", async () => {
    const files = new Map([["/opt/stacks/blog/compose.yaml", "old"]]);
    await ready(files);
    const saved = await server!.request("PUT", "/stacks/s1/blog/compose", {
      body: { content: "new: 1" },
    });
    expect(saved.status).toBe(200);
    expect(files.get("/opt/stacks/blog/compose.yaml")).toBe("new: 1");
    await server!.request("PUT", "/stacks/s1/blog/env", {
      body: { content: "B=2\n" },
    });
    expect(files.get("/opt/stacks/blog/.env")).toBe("B=2\n");
    const missing = await server!.request("PUT", "/stacks/s1/nope/env", {
      body: { content: "x" },
    });
    expect(missing.status).toBe(404);
  });

  it("runs actions in the stack folder and rejects unknown ones", async () => {
    const files = new Map([["/opt/stacks/blog/compose.yaml", "services: {}"]]);
    await ready(files);
    const bad = await server!.request("POST", "/stacks/s1/blog/action", {
      body: { action: "rm -rf" },
    });
    expect(bad.status).toBe(400);
    const badService = await server!.request("POST", "/stacks/s1/blog/action", {
      body: { action: "restart", service: "a;b" },
    });
    expect(badService.status).toBe(400);
    const ok = await server!.request("POST", "/stacks/s1/blog/action", {
      body: { action: "deploy" },
    });
    expect(ok.status).toBe(200);
    expect(
      server!.client.commands.some(
        (c) =>
          c.includes("cd '/opt/stacks/blog'") &&
          c.includes("compose -p blog up -d --remove-orphans"),
      ),
    ).toBe(true);
  });

  it("deletes the folder only when asked on destroy", async () => {
    const files = new Map([["/opt/stacks/blog/compose.yaml", "services: {}"]]);
    await ready(files);
    server!.client.reply(/ down /, { stdout: "" });
    await server!.request("POST", "/stacks/s1/blog/action", {
      body: { action: "destroy", removeVolumes: true },
    });
    expect(server!.client.commands.some((c) => c.includes("rm -rf"))).toBe(
      false,
    );
    await server!.request("POST", "/stacks/s1/blog/action", {
      body: { action: "destroy", removeFiles: true },
    });
    expect(
      server!.client.commands.some((c) =>
        c.includes("rm -rf -- '/opt/stacks/blog'"),
      ),
    ).toBe(true);
  });

  it("returns stack logs and checks the compose text", async () => {
    await ready(new Map([["/opt/stacks/blog/compose.yaml", "services: {}"]]));
    const logs = await server!.request(
      "GET",
      "/stacks/s1/blog/logs?service=app&tail=50",
    );
    expect(logs.body.logs).toContain("hello");
    expect(
      server!.client.commands.some((c) => c.includes("--tail 50 app")),
    ).toBe(true);
    const badLogs = await server!.request(
      "GET",
      "/stacks/s1/blog/logs?service=a%3Bb",
    );
    expect(badLogs.status).toBe(400);
    const check = await server!.request("POST", "/stacks/s1/validate", {
      body: { compose: "services: {}", name: "blog" },
    });
    expect(check.body).toMatchObject({ valid: true });
  });
});
