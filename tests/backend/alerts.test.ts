import { afterEach, describe, expect, it } from "vitest";
import { containerProblems } from "../../src/backend/summary.js";
import { dockerClient, startServer, type TestServer } from "./server";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const row = (name: string, state: string, status: string) =>
  JSON.stringify({ name, state, status });

describe("containerProblems", () => {
  it("flags unhealthy, restarting and failed containers only", () => {
    const output = [
      row("ok", "running", "Up 1 hour"),
      row("sick", "running", "Up 1 hour (unhealthy)"),
      row("loop", "restarting", "Restarting (1) 3 seconds ago"),
      row("crashed", "exited", "Exited (137) 2 minutes ago"),
      row("done", "exited", "Exited (0) 2 minutes ago"),
    ].join("\n");
    expect(containerProblems(output)).toEqual([
      { name: "sick", kind: "unhealthy" },
      { name: "loop", kind: "restarting" },
      { name: "crashed", kind: "exited" },
    ]);
  });
});

describe("container alerts", () => {
  it("alerts once per problem for hosts that opted in", async () => {
    server = await startServer();
    server.client.reply(/ ps -a --format/, {
      stdout: `${row("web", "exited", "Exited (1) now")}\n`,
    });
    await server.mock.ctx.settings.setHost(7, "alertProblems", true);
    await server.mock.ctx.kv.set("alerts:7", "user-1");

    await server.mock.runScheduled();
    await server.mock.runScheduled();

    expect(server.mock.notifications).toHaveLength(1);
    expect(server.mock.notifications[0].notification).toMatchObject({
      category: "docker.container_problem",
      audience: { userId: "user-1" },
      dedupeKey: "docker.container_problem:7:web:exited",
    });
  });

  it("stays quiet when the host did not opt in", async () => {
    server = await startServer();
    server.client.reply(/ ps -a --format/, {
      stdout: `${row("web", "exited", "Exited (1) now")}\n`,
    });
    await server.mock.ctx.kv.set("alerts:7", "user-1");
    await server.mock.runScheduled();
    expect(server.mock.notifications).toHaveLength(0);
    expect(await server.mock.ctx.kv.get("alerts:7")).toBeFalsy();
  });
});
