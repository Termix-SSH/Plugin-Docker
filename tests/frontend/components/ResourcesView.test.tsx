import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  listImages: vi.fn(async () => [
    {
      id: "1111111111aa",
      repository: "nginx",
      tag: "latest",
      size: "187MB",
      created: "2 weeks ago",
      inUse: true,
    },
    {
      id: "2222222222bb",
      repository: "redis",
      tag: "7",
      size: "40MB",
      created: "3 days ago",
      inUse: false,
    },
  ]),
  listVolumes: vi.fn(async () => []),
  listNetworks: vi.fn(async () => [
    { id: "aa", name: "bridge", driver: "bridge", builtIn: true },
    { id: "bb", name: "app", driver: "bridge", builtIn: false },
  ]),
  inspectResource: vi.fn(async () => ({ Name: "x" })),
  resourceAction: vi.fn(async () => ({ success: true, message: "ok" })),
}));
vi.mock("../../../src/frontend/docker-api", () => ({
  useDockerApi: () => api,
}));

import { ResourcesView } from "../../../src/frontend/resources/ResourcesView";

describe("ResourcesView", () => {
  it("lists images and filters to unused ones", async () => {
    render(<ResourcesView sessionId="s1" section="images" switcher={null} />);
    await waitFor(() => expect(screen.getByText("nginx")).toBeTruthy());
    expect(screen.getByText("redis")).toBeTruthy();
    fireEvent.click(screen.getAllByText("docker.resources.unused")[0]);
    await waitFor(() => expect(screen.queryByText("nginx")).toBeNull());
    expect(screen.getByText("redis")).toBeTruthy();
  });

  it("offers no remove button on the runtime's own networks", async () => {
    render(<ResourcesView sessionId="s1" section="networks" switcher={null} />);
    await waitFor(() => expect(screen.getByText("app")).toBeTruthy());
    expect(screen.getAllByTitle("common.remove")).toHaveLength(1);
  });

  it("pulls an image from the form", async () => {
    render(<ResourcesView sessionId="s1" section="images" switcher={null} />);
    await waitFor(() => expect(screen.getByText("nginx")).toBeTruthy());
    fireEvent.click(screen.getAllByText("docker.resources.image.add")[0]);
    fireEvent.change(screen.getByPlaceholderText("nginx:latest"), {
      target: { value: "alpine:3.20" },
    });
    fireEvent.click(screen.getByText("docker.resources.image.save"));
    await waitFor(() =>
      expect(api.resourceAction).toHaveBeenCalledWith("s1", "pull-image", {
        image: "alpine:3.20",
      }),
    );
  });
});
