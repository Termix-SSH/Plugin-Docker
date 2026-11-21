import { describe, expect, it, vi } from "vitest";
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import {
  registerTreeChildren,
  toTreeChildren,
  treeState,
} from "../../src/frontend/tree-children";

describe("host tree children", () => {
  it("maps Docker states to tree states", () => {
    expect(treeState("running")).toBe("running");
    expect(treeState("restarting")).toBe("running");
    expect(treeState("paused")).toBe("paused");
    expect(treeState("exited")).toBe("stopped");
    expect(treeState("created")).toBe("stopped");
    expect(treeState("removing")).toBe("unknown");
  });

  it("turns containers into items that open the Docker tab on them", () => {
    expect(
      toTreeChildren([{ name: "web", state: "running", status: "Up 1 hour" }]),
    ).toEqual([
      {
        id: "web",
        label: "web",
        detail: "Up 1 hour",
        kind: "container",
        state: "running",
        tabType: "docker",
        data: { focus: { container: "web" } },
      },
    ]);
  });

  it("registers only on a Termix that has host trees", () => {
    const when = () => true;
    expect(() => registerTreeChildren({} as TermixApp, when)).not.toThrow();
    const registerHostTreeChildren = vi.fn();
    registerTreeChildren(
      { registerHostTreeChildren } as unknown as TermixApp,
      when,
    );
    expect(registerHostTreeChildren).toHaveBeenCalledWith(
      expect.objectContaining({ id: "containers", when }),
    );
  });
});
