import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ConsoleTerminal } from "../../../src/frontend/components/ConsoleTerminal";

describe("ConsoleTerminal", () => {
  it("keeps the terminal laid out before connecting so it can measure its size", () => {
    const { container } = render(
      <ConsoleTerminal
        containerId="3f2a91c4b7e1"
        containerName="app"
        containerState="running"
        hostConfig={{ id: 1, name: "web", ip: "10.0.0.5", port: 22 }}
      />,
    );
    const xterm = container.querySelector<HTMLElement>(
      ".h-full.w-full[style*='visibility']",
    );
    expect(xterm).not.toBeNull();
    expect(xterm!.style.visibility).toBe("hidden");
    expect(xterm!.style.display).not.toBe("none");
  });
});
