import React from "react";
import { Play, RotateCw, Square } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button } from "@termix-ssh/plugin-sdk/ui";
import type { DockerContainer } from "../types";
import { useDockerApi } from "../docker-api";
import { getErrorMessage } from "../error-message";
import { UpdateBadge, UpdateButton } from "../updates";

interface CompactContainerListProps {
  containers: DockerContainer[];
  sessionId: string;
  onSelectContainer: (containerId: string) => void;
  onRefresh?: () => void;
  search?: string;
  statusFilter?: string;
}

function stateColor(state: DockerContainer["state"]): string {
  if (state === "running") return "bg-accent-brand";
  if (state === "paused") return "bg-warning";
  if (state === "exited" || state === "dead") return "bg-destructive";
  return "bg-muted-foreground";
}

/** One line per container, for a narrow side panel. */
export function CompactContainerList({
  containers,
  sessionId,
  onSelectContainer,
  onRefresh,
  search = "",
  statusFilter = "all",
}: CompactContainerListProps): React.ReactElement {
  const { t } = useTranslation();
  const docker = useDockerApi();
  const [busy, setBusy] = React.useState<string | null>(null);

  const filtered = React.useMemo(() => {
    const needle = search.toLowerCase();
    return containers.filter((c) => {
      const name = c.name.startsWith("/") ? c.name.slice(1) : c.name;
      const matches =
        name.toLowerCase().includes(needle) ||
        c.image.toLowerCase().includes(needle) ||
        c.id.toLowerCase().includes(needle);
      return matches && (statusFilter === "all" || c.state === statusFilter);
    });
  }, [containers, search, statusFilter]);

  const act = async (
    event: React.MouseEvent,
    container: DockerContainer,
    action: "start" | "stop" | "restart",
  ) => {
    event.stopPropagation();
    const name = container.name.replace(/^\//, "");
    setBusy(container.id);
    try {
      await docker.containerAction(sessionId, container.id, action);
      onRefresh?.();
    } catch (err) {
      toast.error(getErrorMessage(err) || name);
    } finally {
      setBusy(null);
    }
  };

  if (filtered.length === 0) {
    return (
      <div className="py-10 text-center text-xs text-muted-foreground">
        {containers.length === 0
          ? t("docker.noContainersFound")
          : t("docker.noContainersMatchFilters")}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {filtered.map((container) => {
        const name = container.name.replace(/^\//, "");
        const running = container.state === "running";
        return (
          <div
            key={container.id}
            role="button"
            tabIndex={0}
            onClick={() => onSelectContainer(container.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSelectContainer(container.id);
            }}
            className="flex cursor-pointer items-center gap-2 border-b border-border/60 px-1 py-2 hover:bg-muted/50"
          >
            <span
              className={`size-2 shrink-0 ${stateColor(container.state)}`}
              title={container.state}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <span className="truncate text-xs font-semibold">{name}</span>
                <UpdateBadge image={container.image} />
              </div>
              <div className="truncate font-mono text-[10px] text-muted-foreground">
                {container.image}
              </div>
            </div>
            <div className="flex shrink-0 items-center">
              <UpdateButton container={container} />
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={busy === container.id}
                title={running ? t("docker.stop") : t("docker.start")}
                aria-label={running ? t("docker.stop") : t("docker.start")}
                className={running ? "text-destructive" : "text-accent-brand"}
                onClick={(event) =>
                  void act(event, container, running ? "stop" : "start")
                }
              >
                {running ? (
                  <Square className="size-3" />
                ) : (
                  <Play className="size-3" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={busy === container.id || container.state === "exited"}
                title={t("docker.restart")}
                aria-label={t("docker.restart")}
                onClick={(event) => void act(event, container, "restart")}
              >
                <RotateCw className="size-3" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
