import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const copyToClipboard = vi.fn(async (_text: string) => true);

vi.mock("@termix-ssh/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@termix-ssh/plugin-sdk/ui")>()),
  copyToClipboard: (text: string) => copyToClipboard(text),
}));

vi.mock("../../../src/frontend/docker-api", () => {
  const api = {
    logs: vi.fn(async () => ({ logs: "starting\nready\nerror: oops\n" })),
  };
  return { useDockerApi: () => api };
});

import { LogViewer } from "../../../src/frontend/components/LogViewer";

describe("LogViewer", () => {
  it("copies the lines that match the filter", async () => {
    render(<LogViewer sessionId="s1" containerId="c1" containerName="web" />);
    expect(await screen.findByText("ready")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("docker.copyLogs"));
    await waitFor(() =>
      expect(copyToClipboard).toHaveBeenCalledWith(
        "starting\nready\nerror: oops",
      ),
    );

    fireEvent.change(screen.getByLabelText("docker.filterLogs"), {
      target: { value: "ready" },
    });
    fireEvent.click(screen.getByLabelText("docker.copyLogs"));
    await waitFor(() =>
      expect(copyToClipboard).toHaveBeenLastCalledWith("ready"),
    );
  });
});
