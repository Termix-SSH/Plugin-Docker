import { afterEach, describe, expect, it } from "vitest";
import { parseManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifest from "../../manifest.json";
import { startServer, type TestServer } from "./server";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const context = (hostId: number, resourceKey?: string) => ({
  hostId,
  resourceKey,
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

describe("declared operations", () => {
  it("has a handler for every declared action", async () => {
    server = await startServer();
    for (const action of manifest.contributes.operations.actions) {
      expect(server.mock.operationHandlers.has(action.id)).toBe(true);
    }
  });

  it("is a valid manifest", () => {
    expect(parseManifest(manifest).errors ?? []).toEqual([]);
  });

  it("needs edit for every change", () => {
    for (const action of manifest.contributes.operations.actions) {
      if (action.risk === "read") continue;
      expect(action.hostAccess).toBe("edit");
    }
  });

  it("keeps remove away from the assistant and MCP", () => {
    const remove = manifest.contributes.operations.actions.find(
      (action) => action.id === "docker.remove-container",
    );
    expect(remove?.risk).toBe("destructive");
    expect(remove?.surfaces).toEqual({ mcp: false, assistant: false });
  });
});

describe("handlers", () => {
  it("lists containers as table rows", async () => {
    server = await startServer();
    const result = await server.mock.ctx.asUser("user-1", () =>
      handler("docker.list-containers").run({}, context(7)),
    );
    expect(result.data).toEqual({
      rows: [expect.objectContaining({ id: "abc123", name: "web" })],
    });
  });

  it("restarts a container on a pooled connection", async () => {
    server = await startServer();
    const result = await server.mock.ctx.asUser("user-1", () =>
      handler("docker.restart-container").run({}, context(7, "web")),
    );
    expect(server.client.commands.at(-1)).toMatch(/ docker restart web$/);
    expect(result).toEqual({ summary: "Restarted web", changed: true });
  });

  it("removes by force only when asked", async () => {
    server = await startServer();
    await server.mock.ctx.asUser("user-1", () =>
      handler("docker.remove-container").run({}, context(7, "web")),
    );
    expect(server.client.commands.at(-1)).toMatch(/ docker rm web$/);
    await server.mock.ctx.asUser("user-1", () =>
      handler("docker.remove-container").run(
        { force: true },
        context(7, "web"),
      ),
    );
    expect(server.client.commands.at(-1)).toMatch(/ docker rm -f web$/);
  });

  it("refuses a name that could be a command", async () => {
    server = await startServer();
    await expect(
      server.mock.ctx.asUser("user-1", () =>
        handler("docker.restart-container").run(
          {},
          context(7, "web; rm -rf /"),
        ),
      ),
    ).rejects.toThrow("Invalid container name");
    expect(server.client.commands.join("\n")).not.toContain("rm -rf");
  });

  it("describes a dry run without running anything", async () => {
    server = await startServer();
    const before = server.client.commands.length;
    const text = await handler("docker.stop-container").describe?.(
      {},
      context(7, "web"),
    );
    expect(text).toBe("Would stop container web");
    expect(server.client.commands.length).toBe(before);
  });
});
