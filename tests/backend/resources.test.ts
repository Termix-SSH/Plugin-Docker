import { afterEach, describe, expect, it } from "vitest";
import {
  parseImages,
  parseNetworks,
  parseVolumes,
  reclaimed,
  resourceArgs,
} from "../../src/backend/resources.js";
import { startServer, type TestServer } from "./server";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const context = (hostId: number) => ({
  hostId,
  runId: "run",
  dryRun: false,
  signal: new AbortController().signal,
  log: () => {},
});

function handler(id: string) {
  const found = server!.mock.operationHandlers.get(id);
  if (!found) throw new Error(`No handler for ${id}`);
  return found;
}

describe("parsers", () => {
  it("marks images a container was made from as in use", () => {
    const rows = parseImages(
      [
        "1111111111aa\tnginx\tlatest\t187MB\t2 weeks ago",
        "2222222222bb\tredis\t7\t40MB\t3 days ago",
        "3333333333cc\t<none>\t<none>\t12MB\t5 months ago",
      ].join("\n"),
      "nginx\n3333333333cc\n",
    );
    expect(rows.map((row) => [row.repository, row.inUse])).toEqual([
      ["nginx", true],
      ["redis", false],
      ["<none>", true],
    ]);
    expect(rows[1]).toMatchObject({ tag: "7", size: "40MB" });
  });

  it("marks dangling volumes as unused", () => {
    expect(
      parseVolumes(
        "data\tlocal\t/var/lib/docker/volumes/data/_data\ncache\tlocal\t/x\n",
        "cache\n",
      ),
    ).toEqual([
      {
        name: "data",
        driver: "local",
        mountpoint: "/var/lib/docker/volumes/data/_data",
        inUse: true,
      },
      { name: "cache", driver: "local", mountpoint: "/x", inUse: false },
    ]);
  });

  it("flags the networks the runtime owns", () => {
    expect(
      parseNetworks("aa\tbridge\tbridge\nbb\tapp_default\tbridge\n"),
    ).toEqual([
      { id: "aa", name: "bridge", driver: "bridge", builtIn: true },
      { id: "bb", name: "app_default", driver: "bridge", builtIn: false },
    ]);
  });

  it("reads the space a prune freed", () => {
    expect(reclaimed("Deleted: x\nTotal reclaimed space: 1.2GB\n")).toBe(
      "1.2GB",
    );
    expect(reclaimed("")).toBe("");
  });
});

describe("command builders", () => {
  it("refuses names that could break the command line", () => {
    expect(() => resourceArgs.removeVolume("a; rm -rf /")).toThrow();
    expect(() => resourceArgs.removeImage("$(id)", false)).toThrow();
    expect(() => resourceArgs.inspectNetwork("-rf")).toThrow();
    expect(() =>
      resourceArgs.createNetwork("ok", "bridge", "1.2.3.4/24; x"),
    ).toThrow();
    expect(() => resourceArgs.createNetwork("ok", "weird", "")).toThrow();
  });

  it("builds the commands", () => {
    expect(resourceArgs.pullImage("ghcr.io/a/b:1.2")).toBe(
      "pull ghcr.io/a/b:1.2",
    );
    expect(resourceArgs.removeImage("nginx:latest", true)).toBe(
      "image rm -f nginx:latest",
    );
    expect(resourceArgs.pruneImages(true)).toBe("image prune -f -a");
    expect(resourceArgs.createNetwork("lan", "macvlan", "10.0.0.0/24")).toBe(
      "network create --driver macvlan --subnet 10.0.0.0/24 lan",
    );
  });
});

describe("resource operations", () => {
  it("prunes volumes with -a and falls back on older Docker", async () => {
    server = await startServer();
    server.client.reply(/volume prune -f -a/, {
      code: 1,
      stderr: "unknown shorthand flag: 'a' in -a",
    });
    server.client.reply(/volume prune -f$/, {
      stdout: "Total reclaimed space: 5MB\n",
    });
    const result = await server.mock.ctx.asUser("user-1", () =>
      handler("docker.prune-volumes").run({}, context(7)),
    );
    expect(result).toMatchObject({ summary: "Freed 5MB", changed: true });
    expect(server.client.commands.slice(-2)).toEqual([
      expect.stringMatching(/volume prune -f -a$/),
      expect.stringMatching(/volume prune -f$/),
    ]);
  });

  it("pulls the image it is given", async () => {
    server = await startServer();
    await server.mock.ctx.asUser("user-1", () =>
      handler("docker.pull-image").run({ image: "redis:7" }, context(7)),
    );
    expect(server.client.commands.at(-1)).toMatch(/ docker pull redis:7$/);
  });
});

describe("resource routes", () => {
  async function connected() {
    const s = await startServer();
    s.client.reply(/ image ls --format/, {
      stdout: "1111111111aa\tnginx\tlatest\t187MB\t2 weeks ago\n",
    });
    s.client.reply(/ ps -a --format "\{\{\.Image\}\}"/, { stdout: "nginx\n" });
    s.client.reply(/ network ls --format/, {
      stdout: "aa\tbridge\tbridge\n",
    });
    s.client.reply(/ network inspect bridge$/, {
      stdout: '[{"Name":"bridge"}]',
    });
    await s.request("POST", "/ssh/connect", {
      body: { sessionId: "s1", hostId: 7 },
    });
    return s;
  }

  it("lists images and networks on the session's host", async () => {
    server = await connected();
    const images = await server.request("GET", "/images/s1");
    expect(images.status).toBe(200);
    expect(images.body[0]).toMatchObject({ repository: "nginx", inUse: true });
    const networks = await server.request("GET", "/networks/s1");
    expect(networks.body[0]).toMatchObject({ name: "bridge", builtIn: true });
  });

  it("inspects one network and refuses a bad name", async () => {
    server = await connected();
    const ok = await server.request("GET", "/inspect/s1/network?name=bridge");
    expect(ok.body).toEqual({ Name: "bridge" });
    const bad = await server.request(
      "GET",
      "/inspect/s1/network?name=%24%28id%29",
    );
    expect(bad.status).toBe(400);
  });

  it("runs a write as an operation and says why it failed", async () => {
    server = await connected();
    server.client.reply(/ volume rm data$/, {
      code: 1,
      stderr: "volume is in use",
    });
    const unknown = await server.request("POST", "/resources/s1/explode");
    expect(unknown.status).toBe(404);
    const failed = await server.request("POST", "/resources/s1/remove-volume", {
      body: { name: "data" },
    });
    expect(failed.status).toBe(422);
    expect(failed.body.error).toMatch(/in use/);
  });

  it("needs a session the caller owns", async () => {
    server = await connected();
    const other = await server.request("GET", "/images/s1", { user: "user-2" });
    expect(other.status).toBe(400);
  });
});
