import { afterEach, describe, expect, it } from "vitest";
import {
  compareDigests,
  composeTargetOf,
  parseRepoDigests,
} from "../../src/backend/updates";
import { dockerClient, startServer, type TestServer } from "./server";

let server: TestServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

const COMPOSE_LABELS = {
  "com.docker.compose.project": "blog",
  "com.docker.compose.service": "app",
  "com.docker.compose.project.working_dir": "/opt/stacks/blog",
  "com.docker.compose.project.config_files": "/opt/stacks/blog/compose.yaml",
};

async function ready(setup: (client: ReturnType<typeof dockerClient>) => void) {
  const client = dockerClient();
  setup(client);
  server = await startServer({ client });
  await server.request("POST", "/ssh/connect", {
    body: { sessionId: "s1", hostId: 7 },
  });
  return server;
}

describe("update helpers", () => {
  it("reads repo digests", () => {
    expect(parseRepoDigests('["nginx@sha256:aaa","x@sha256:bbb"]')).toEqual([
      "sha256:aaa",
      "sha256:bbb",
    ]);
    expect(parseRepoDigests("null")).toEqual([]);
    expect(parseRepoDigests("nope")).toEqual([]);
  });

  it("compares the local digests with the registry", () => {
    expect(compareDigests(["sha256:a"], "sha256:a\n").status).toBe("current");
    expect(compareDigests(["sha256:a"], "sha256:b").status).toBe("update");
    expect(compareDigests([], "sha256:b").status).toBe("unknown");
    expect(compareDigests(["sha256:a"], "garbage").status).toBe("unknown");
  });

  it("finds the compose service of a container", () => {
    expect(composeTargetOf(COMPOSE_LABELS)).toMatchObject({
      project: "blog",
      service: "app",
    });
    expect(composeTargetOf({})).toBeNull();
    expect(
      composeTargetOf({
        ...COMPOSE_LABELS,
        "com.docker.compose.service": "a;rm -rf /",
      }),
    ).toBeNull();
    expect(
      composeTargetOf({
        ...COMPOSE_LABELS,
        "com.docker.compose.project.working_dir": "relative",
      }),
    ).toBeNull();
  });
});

describe("update routes", () => {
  it("marks images with a newer digest and keeps the rest current", async () => {
    await ready((client) => {
      client.reply(/ps -a --format '\{\{\.Image\}\}'/, {
        stdout: "nginx:latest\nredis:7\nsha256:abc\n",
      });
      client.reply(/image inspect 'nginx:latest'/, {
        stdout: '["nginx@sha256:old"]',
      });
      client.reply(/image inspect 'redis:7'/, {
        stdout: '["redis@sha256:same"]',
      });
      client.reply(/imagetools inspect 'nginx:latest'/, {
        stdout: "sha256:new\n",
      });
      client.reply(/imagetools inspect 'redis:7'/, { stdout: "sha256:same\n" });
    });
    const res = await server!.request("GET", "/updates/s1");
    expect(res.status).toBe(200);
    expect(res.body.images["nginx:latest"].status).toBe("update");
    expect(res.body.images["redis:7"].status).toBe("current");
    expect(res.body.images["sha256:abc"].status).toBe("pinned");
  });

  it("reports unknown when the registry cannot be reached", async () => {
    await ready((client) => {
      client.reply(/ps -a --format '\{\{\.Image\}\}'/, { stdout: "nginx\n" });
      client.reply(/image inspect/, { stdout: '["nginx@sha256:a"]' });
      client.reply(/imagetools/, { stdout: "", code: 1 });
    });
    const res = await server!.request("GET", "/updates/s1");
    expect(res.body.images.nginx).toEqual({
      status: "unknown",
      reason: "registry",
    });
  });

  it("updates a compose container by pulling and recreating the service", async () => {
    await ready((client) => {
      client.reply(/ inspect abc123/, {
        stdout: JSON.stringify([
          { Config: { Image: "nginx", Labels: COMPOSE_LABELS } },
        ]),
      });
      client.reply(/compose .* pull app/, { stdout: "pulled" });
      client.reply(/compose .* up -d app/, { stdout: "started" });
    });
    const res = await server!.request("POST", "/updates/s1/abc123");
    expect(res.status).toBe(200);
    expect(res.body.recreated).toBe(true);
    const commands = server!.client.commands.join("\n");
    expect(commands).toContain("cd '/opt/stacks/blog'");
    expect(commands).toContain("-p blog -f '/opt/stacks/blog/compose.yaml'");
    expect(commands).toContain("up -d app");
  });

  it("only pulls the image of a container outside compose", async () => {
    await ready((client) => {
      client.reply(/ inspect abc123/, {
        stdout: JSON.stringify([{ Config: { Image: "nginx", Labels: {} } }]),
      });
      client.reply(/ pull 'nginx'/, { stdout: "pulled" });
    });
    const res = await server!.request("POST", "/updates/s1/abc123");
    expect(res.body).toMatchObject({ success: true, recreated: false });
  });

  it("returns the compose output when the update fails", async () => {
    await ready((client) => {
      client.reply(/ inspect abc123/, {
        stdout: JSON.stringify([
          { Config: { Image: "nginx", Labels: COMPOSE_LABELS } },
        ]),
      });
      client.reply(/compose .* pull app/, { stdout: "denied", code: 1 });
    });
    const res = await server!.request("POST", "/updates/s1/abc123");
    expect(res.status).toBe(500);
    expect(res.body.error).toContain("denied");
  });

  it("refuses an invalid container id", async () => {
    await ready(() => {});
    const res = await server!.request("POST", "/updates/s1/a;b");
    expect(res.status).toBe(400);
  });
});
