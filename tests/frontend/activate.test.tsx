import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

const declared = (views?: Array<{ id: string }>) =>
  (views ?? []).map((view) => view.id).sort();

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

describe(`${manifest.id} activate`, () => {
  it("activates and registers only views its manifest declares", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    const contributes = manifest.contributes as unknown as Record<
      string,
      Array<{ id: string }> | undefined
    >;
    const tabs = declared(contributes.tabs);
    // A rail panel may reuse one of the plugin's tab ids.
    const panels = [...declared(contributes.panels), ...tabs];
    const cards = declared(contributes.dashboardCards);
    for (const id of rendered.registered.tabs()) expect(tabs).toContain(id);
    for (const id of rendered.registered.panels()) expect(panels).toContain(id);
    for (const id of rendered.registered.dashboardCards()) {
      expect(cards).toContain(id);
    }
    // Host settings render from the manifest; there is no editor tab.
    expect(rendered.registered.hostEditorSections()).toEqual([]);
    expect(rendered.registered.hostActions()).toEqual([
      expect.objectContaining({ id: "docker", tabType: "docker" }),
    ]);
  });

  it("removes everything it registered on deactivate", async () => {
    const app = await renderWithApp(plugin, { manifest, locales });
    await app.deactivate();
    expect(app.registered.tabs()).toEqual([]);
    expect(app.registered.panels()).toEqual([]);
    expect(app.registered.railItems()).toEqual([]);
    expect(app.registered.hostActions()).toEqual([]);
    expect(app.registered.hostEditorSections()).toEqual([]);
    expect(app.registered.dashboardCards()).toEqual([]);
    expect(app.registered.settingsComponents()).toEqual([]);
    expect(app.registered.actions()).toEqual([]);
  });
});

describe("docker hosts dashboard card", () => {
  it("shows container counts per host", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["docker.use"],
      hosts: [{ id: "7", name: "apps", ip: "10.0.0.7", port: 22 }],
      api: {
        get: vi.fn(async () => ({
          data: [
            {
              hostId: 7,
              running: 4,
              stopped: 1,
              unhealthy: 1,
              total: 5,
              checkedAt: "",
            },
          ],
        })),
      } as never,
    });
    expect(rendered.registered.dashboardCards()).toEqual(["docker-hosts"]);
    rendered.renderDashboardCard("docker-hosts");
    expect(await screen.findByText("apps")).toBeTruthy();
    expect(screen.getByText("4 running | 1 stopped")).toBeTruthy();
    expect(screen.getByText("4 of 5 containers running")).toBeTruthy();
  });
});
