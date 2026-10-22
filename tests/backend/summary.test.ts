import { afterEach, describe, expect, it } from "vitest";
import { countContainers, mapLimit } from "../../src/backend/summary.js";
import { startServer, type TestServer } from "./server";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const summary = (id: number) => ({
  id,
  userId: "user-1",
  name: `host-${id}`,
  ip: `10.0.0.${id}`,
  port: 22,
  username: "root",
  tags: null,
  folder: null,
  authType: "password",
});

const ps = [
  `{"name":"web","state":"running","status":"Up 2 hours"}`,
  `{"name":"db","state":"running","status":"Up 2 hours (unhealthy)"}`,
  `{"name":"old","state":"exited","status":"Exited (0)"}`,
].join("\n");

describe("container counts", () => {
  it("counts running, stopped and unhealthy containers", () => {
    expect(countContainers(ps)).toEqual({
      running: 2,
      stopped: 1,
      unhealthy: 1,
      total: 3,
    });
  });

  it("never runs more than the limit at once", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBe(2);
  });
});

describe("GET /summary", () => {
  it("checks only hosts with Docker on and caches the result", async () => {
    server = await startServer({ mock: { hosts: [summary(7), summary(8)] } });
    server.client.reply(/ ps -a --format/, { stdout: ps });

    const first = await server.request("GET", "/summary");
    expect(first.status).toBe(200);
    expect(first.body).toEqual([
      expect.objectContaining({ hostId: 7, running: 2, stopped: 1 }),
    ]);
    const runs = server.client.commands.filter((c) => /ps -a/.test(c)).length;

    await server.request("GET", "/summary");
    expect(server.client.commands.filter((c) => /ps -a/.test(c)).length).toBe(
      runs,
    );

    await server.request("GET", "/summary?refresh=1");
    expect(server.client.commands.filter((c) => /ps -a/.test(c)).length).toBe(
      runs + 1,
    );
  });

  it("needs docker.use", async () => {
    server = await startServer({ permissions: [] });
    expect((await server.request("GET", "/summary")).status).toBe(403);
  });
});
