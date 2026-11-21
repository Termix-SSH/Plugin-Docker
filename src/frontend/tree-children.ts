import { useEffect, useState } from "react";
import {
  usePermission,
  usePluginApi,
  type PluginHostRecord,
  type TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";

const POLL_MS = 30_000;

interface TreeContainer {
  name: string;
  state: string;
  status: string;
}

interface TreeChild {
  id: string;
  label: string;
  detail?: string;
  kind: "container";
  state: "running" | "stopped" | "paused" | "unknown";
  tabType: string;
  data: Record<string, unknown>;
}

interface TreeResult {
  items: TreeChild[];
  loading?: boolean;
  error?: string;
}

/** registerHostTreeChildren is in Termix 26.11.3 and newer. */
type TreeApp = TermixApp & {
  registerHostTreeChildren?: (provider: {
    id: string;
    titleKey?: string;
    when: (host: PluginHostRecord) => boolean;
    useChildren: (host: PluginHostRecord) => TreeResult | null;
    order?: number;
  }) => unknown;
};

export function treeState(state: string): TreeChild["state"] {
  if (state === "running" || state === "restarting") return "running";
  if (state === "paused") return "paused";
  if (state === "exited" || state === "created" || state === "dead") {
    return "stopped";
  }
  return "unknown";
}

export function toTreeChildren(containers: TreeContainer[]): TreeChild[] {
  return containers.map((container) => ({
    id: container.name,
    label: container.name,
    detail: container.status || undefined,
    kind: "container",
    state: treeState(container.state),
    tabType: "docker",
    data: { focus: { container: container.name } },
  }));
}

/** The host's containers while a host tree shows the host open. */
export function useDockerTreeChildren(host: PluginHostRecord): TreeResult {
  const api = usePluginApi();
  const allowed = usePermission("use");
  const [result, setResult] = useState<TreeResult>({
    items: [],
    loading: true,
  });
  const hostId = host.id;

  useEffect(() => {
    if (!allowed) return;
    let stopped = false;
    const load = async () => {
      try {
        const { data } = await api.get<{ items: TreeContainer[] }>("/tree", {
          params: { hostId },
        });
        if (!stopped) setResult({ items: toTreeChildren(data.items ?? []) });
      } catch (error) {
        const message =
          (error as { response?: { data?: { error?: string } } })?.response
            ?.data?.error ?? (error as Error)?.message;
        if (!stopped) setResult({ items: [], error: message });
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api, hostId, allowed]);

  return allowed ? result : { items: [] };
}

export function registerTreeChildren(
  app: TermixApp,
  when: (host: PluginHostRecord) => boolean,
): void {
  (app as TreeApp).registerHostTreeChildren?.({
    id: "containers",
    titleKey: "tree.containers",
    order: 30,
    when,
    useChildren: useDockerTreeChildren,
  });
}
