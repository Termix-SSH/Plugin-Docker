import { useCallback, useEffect, useState } from "react";
import { Box, RefreshCw } from "lucide-react";
import {
  useHosts,
  usePermission,
  usePluginApi,
  useTabs,
  useTranslation,
  type DashboardCardProps,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  ListBadge,
  ListRow,
  PanelList,
} from "@termix-ssh/plugin-sdk/ui";

const POLL_MS = 60_000;

export interface HostContainerSummary {
  hostId: number;
  running: number;
  stopped: number;
  unhealthy: number;
  total: number;
  error?: string;
  checkedAt: string;
}

/** Dashboard card: running and stopped containers on each Docker host. */
export function DockerHostsCard({ isVisible }: DashboardCardProps) {
  const { t } = useTranslation();
  const allowed = usePermission("use");
  const api = usePluginApi();
  const tabs = useTabs();
  const { hosts } = useHosts();
  const [rows, setRows] = useState<HostContainerSummary[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      try {
        const { data } = await api.get<HostContainerSummary[]>("/summary", {
          params: refresh ? { refresh: "1" } : undefined,
        });
        setRows(data);
      } catch {
        setRows([]);
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (!isVisible || !allowed) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [isVisible, allowed, load]);

  if (!allowed) return null;
  if (!rows) {
    return (
      <p className="p-3 text-xs text-muted-foreground">{t("card.loading")}</p>
    );
  }

  const totals = rows.reduce(
    (sum, row) => ({
      running: sum.running + row.running,
      total: sum.total + row.total,
    }),
    { running: 0, total: 0 },
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-3 pt-1">
        <span className="flex-1 text-xs text-muted-foreground">
          {t("card.summary", totals)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          disabled={loading}
          onClick={() => void load(true)}
          title={t("card.refresh")}
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <PanelList
        empty={
          <p className="p-3 text-xs text-muted-foreground">{t("card.empty")}</p>
        }
      >
        {rows.map((row, index) => {
          const host = hosts.find((h) => Number(h.id) === row.hostId);
          return (
            <ListRow
              key={row.hostId}
              stripe={index}
              tone={
                row.error
                  ? "destructive"
                  : row.unhealthy > 0
                    ? "warning"
                    : row.running > 0
                      ? "success"
                      : "muted"
              }
              icon={<Box className="size-3.5" />}
              title={host?.name || host?.ip || `#${row.hostId}`}
              badges={
                row.unhealthy > 0 ? (
                  <ListBadge tone="warning">
                    {t("card.unhealthy", { count: row.unhealthy })}
                  </ListBadge>
                ) : undefined
              }
              meta={
                row.error ??
                t("card.counts", { running: row.running, stopped: row.stopped })
              }
              onClick={() => host && tabs.openTab(host, "docker")}
            />
          );
        })}
      </PanelList>
    </div>
  );
}
