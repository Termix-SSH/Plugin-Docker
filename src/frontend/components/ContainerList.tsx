import type { DockerContainer } from "../types";
import React from "react";
import { Box } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { DataView, EmptyState, type GridSize } from "@termix-ssh/plugin-sdk/ui";
import { ContainerCard } from "./ContainerCard.tsx";

interface ContainerListProps {
  containers: DockerContainer[];
  sessionId: string;
  columns?: GridSize;
  onSelectContainer: (containerId: string) => void;
  selectedContainerId?: string | null;
  onRefresh?: () => void;
  search?: string;
  statusFilter?: string;
}

export function ContainerList({
  containers,
  sessionId,
  columns = "auto",
  onSelectContainer,
  selectedContainerId = null,
  onRefresh,
  search = "",
  statusFilter = "all",
}: ContainerListProps): React.ReactElement {
  const { t } = useTranslation();

  const filtered = React.useMemo(() => {
    return containers.filter((c) => {
      const name = c.name.startsWith("/") ? c.name.slice(1) : c.name;
      const matchesSearch =
        name.toLowerCase().includes(search.toLowerCase()) ||
        c.image.toLowerCase().includes(search.toLowerCase()) ||
        c.id.toLowerCase().includes(search.toLowerCase());
      return (
        matchesSearch && (statusFilter === "all" || c.state === statusFilter)
      );
    });
  }, [containers, search, statusFilter]);

  if (containers.length === 0) {
    return (
      <EmptyState
        icon={Box}
        title={t("docker.noContainersFound")}
        hint={t("docker.noContainersFoundHint")}
      />
    );
  }

  if (filtered.length === 0) {
    return (
      <EmptyState
        icon={Box}
        title={t("docker.noContainersMatchFilters")}
        hint={t("docker.noContainersMatchFiltersHint")}
      />
    );
  }

  return (
    <DataView
      items={filtered}
      view="grid"
      getKey={(container) => container.id}
      renderCard={(container) => (
        <ContainerCard
          container={container}
          sessionId={sessionId}
          onSelect={() => onSelectContainer(container.id)}
          isSelected={selectedContainerId === container.id}
          onRefresh={onRefresh}
        />
      )}
      columns={{ base: 1, md: 2, lg: 3, xl: 4 }}
      size={columns}
      minCardWidth={300}
      listColumns={[]}
      empty={null}
    />
  );
}
