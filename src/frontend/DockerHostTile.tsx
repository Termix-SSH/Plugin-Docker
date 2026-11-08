import { useCallback, useEffect, useState } from "react";
import {
  usePermission,
  usePluginApi,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import { StatTile, TileWall } from "@termix-ssh/plugin-sdk/ui";
import type { HostContainerSummary } from "./DockerHostsCard";

const POLL_MS = 60_000;

/** Container counts for one host, on the host page. */
export function DockerHostTile({
  hostId,
  isVisible = true,
}: {
  hostId: number;
  isVisible?: boolean;
}) {
  const { t } = useTranslation();
  const allowed = usePermission("use");
  const api = usePluginApi();
  const [row, setRow] = useState<HostContainerSummary | null>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<HostContainerSummary[]>("/summary", {
        params: { hostId },
      });
      setRow(data[0] ?? null);
    } catch {
      setRow(null);
    }
  }, [api, hostId]);

  useEffect(() => {
    if (!isVisible || !allowed) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [isVisible, allowed, load]);

  if (!allowed) return null;
  if (!row || row.error) {
    return (
      <p className="p-3 text-xs text-muted-foreground">{t("tile.empty")}</p>
    );
  }
  return (
    <TileWall size="3">
      <StatTile label={t("tile.running")} value={String(row.running)} />
      <StatTile label={t("tile.stopped")} value={String(row.stopped)} />
      <StatTile
        label={t("tile.unhealthy")}
        value={String(row.unhealthy)}
        tone={row.unhealthy > 0 ? "warn" : "default"}
      />
    </TileWall>
  );
}
