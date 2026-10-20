import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const containerAction = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("../../../src/frontend/docker-api", () => ({
  useDockerApi: () => ({ containerAction }),
}));

import { CompactContainerList } from "../../../src/frontend/components/CompactContainerList";
import type { DockerContainer } from "../../../src/frontend/types";

const make = (name: string, state: string) =>
  ({
    id: `${name}-id`,
    name: `/${name}`,
    image: `${name}:latest`,
    state,
    status: "",
    ports: "",
    created: "",
  }) as unknown as DockerContainer;

const containers = [make("web", "running"), make("db", "exited")];

describe("CompactContainerList", () => {
  it("shows one row per container and filters by search and state", () => {
    const { rerender } = render(
      <CompactContainerList
        containers={containers}
        sessionId="s1"
        onSelectContainer={() => {}}
      />,
    );
    expect(screen.getByText("web")).toBeTruthy();
    expect(screen.getByText("db")).toBeTruthy();
    rerender(
      <CompactContainerList
        containers={containers}
        sessionId="s1"
        onSelectContainer={() => {}}
        statusFilter="exited"
      />,
    );
    expect(screen.queryByText("web")).toBeNull();
    rerender(
      <CompactContainerList
        containers={containers}
        sessionId="s1"
        onSelectContainer={() => {}}
        search="nomatch"
      />,
    );
    expect(screen.getByText("docker.noContainersMatchFilters")).toBeTruthy();
  });

  it("opens a container on click and acts without opening it", async () => {
    const onSelect = vi.fn();
    const onRefresh = vi.fn();
    render(
      <CompactContainerList
        containers={containers}
        sessionId="s1"
        onSelectContainer={onSelect}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByText("web"));
    expect(onSelect).toHaveBeenCalledWith("web-id");
    fireEvent.click(screen.getByLabelText("docker.stop"));
    await waitFor(() =>
      expect(containerAction).toHaveBeenCalledWith("s1", "web-id", "stop"),
    );
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
