import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../../src/frontend/docker-api", () => ({
  useDockerApi: () => ({ containerAction: vi.fn(async () => ({})) }),
}));

import { ContainerCard } from "../../../src/frontend/components/ContainerCard";
import type { DockerContainer } from "../../../src/frontend/types";

const container = {
  id: "abcdef1234567890",
  name: "web",
  image: "nginx:alpine",
  state: "running",
  status: "Up 2 minutes",
  ports: "",
  created: "",
} as unknown as DockerContainer;

describe("ContainerCard", () => {
  it("labels each action so it works without hover", () => {
    render(<ContainerCard container={container} sessionId="s1" />);
    for (const label of [
      "docker.stop",
      "docker.pause",
      "docker.restart",
      "docker.remove",
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });
});
