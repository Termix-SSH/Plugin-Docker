import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../../src/frontend/components/ContainerCard.tsx", () => ({
  ContainerCard: ({ container }: { container: { name: string } }) => (
    <div>{container.name}</div>
  ),
}));

import { ContainerList } from "../../../src/frontend/components/ContainerList";
import type { DockerContainer } from "../../../src/frontend/types";

const make = (name: string) =>
  ({
    id: `${name}-id`,
    name,
    image: `${name}:latest`,
    state: "running",
  }) as unknown as DockerContainer;

const containers = [make("web"), make("db")];

function gridOf(container: HTMLElement) {
  return container.querySelector<HTMLElement>(
    "[style*='grid-template-columns']",
  );
}

describe("ContainerList", () => {
  it("fits cards to the pane by default", () => {
    const { container } = render(
      <ContainerList
        containers={containers}
        sessionId="s1"
        onSelectContainer={() => {}}
      />,
    );
    expect(screen.getByText("web")).toBeTruthy();
    expect(gridOf(container)?.style.gridTemplateColumns).toContain("auto-fill");
  });

  it("uses the picked number of cards per row", () => {
    const { container } = render(
      <ContainerList
        containers={containers}
        sessionId="s1"
        columns="2"
        onSelectContainer={() => {}}
      />,
    );
    expect(gridOf(container)?.style.gridTemplateColumns).toContain("/ 2");
  });
});
