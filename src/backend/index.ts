import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { createLogger } from "./helpers.js";
import { createDockerSessions } from "./sessions.js";
import { registerRoutes } from "./routes.js";
import { registerConsole } from "./console.js";
import { registerServices } from "./services.js";
import {
  containerProblems,
  readContainerOutput,
  registerSummary,
} from "./summary.js";
import { startHostAlerts } from "./host-alerts.js";
import { registerOperations } from "./operations.js";
import { normalizeImportedHost } from "./host-settings.js";

export type {
  DockerContainerAction,
  DockerContainerSummary,
  DockerEvent,
  DockerEventsV1,
  DockerServiceV1,
} from "./services.js";

export async function activate(ctx: PluginContext) {
  const log = createLogger(ctx.log);
  const sessions = createDockerSessions(ctx.schedule, log);
  ctx.disposables.add(() => sessions.closeAll());

  const router = ctx.http.router<Router>();
  registerRoutes(router, { ctx, sessions, log });
  registerSummary(router, ctx);
  registerConsole(ctx, log);
  registerServices(ctx, log);
  registerOperations(ctx, sessions);
  startHostAlerts({
    ctx,
    setting: "alertProblems",
    category: "docker.container_problem",
    tab: "docker",
    probe: async (hostId) =>
      containerProblems(await readContainerOutput(ctx, hostId)).map((p) => ({
        key: `${p.name}:${p.kind}`,
        title: `Container ${p.name} is ${p.kind}`,
        body: `${p.name} is ${p.kind}`,
        severity: p.kind === "unhealthy" ? "warning" : "critical",
      })),
  });
  ctx.registry.provide("docker.hostImportNormalizer", normalizeImportedHost);

  ctx.log.info(
    "Docker mounted at /plugin-api/docker and /plugin-ws/docker/console",
  );
}

export async function deactivate() {}
