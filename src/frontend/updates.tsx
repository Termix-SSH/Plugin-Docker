import React from "react";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button } from "@termix-ssh/plugin-sdk/ui";
import { getErrorMessage } from "./error-message";
import { useDockerApi } from "./docker-api";
import type { DockerContainer, ImageUpdate } from "./types";

interface UpdatesValue {
  statusOf: (image: string) => ImageUpdate | undefined;
  updating: Set<string>;
  update: (container: DockerContainer) => void;
}

const UpdatesContext = React.createContext<UpdatesValue>({
  statusOf: () => undefined,
  updating: new Set(),
  update: () => {},
});

export const useUpdates = () => React.useContext(UpdatesContext);
export const UpdatesProvider = UpdatesContext.Provider;

const RECHECK_MS = 30 * 60 * 1000;

/** Update checks for a session: on open, every 30 minutes and on demand. */
export function useUpdateChecker(
  sessionId: string | null,
  active: boolean,
  onUpdated: () => void,
) {
  const { t } = useTranslation();
  const docker = useDockerApi();
  const [images, setImages] = React.useState<Record<string, ImageUpdate>>({});
  const [checking, setChecking] = React.useState(false);
  const [updating, setUpdating] = React.useState<Set<string>>(new Set());

  const check = React.useCallback(
    async (refresh: boolean) => {
      if (!sessionId) return;
      setChecking(true);
      try {
        const result = await docker.checkUpdates(sessionId, refresh);
        setImages(result.images);
        if (refresh) {
          const count = Object.values(result.images).filter(
            (item) => item.status === "update",
          ).length;
          toast.success(
            count > 0
              ? t("docker.updates.found", { count })
              : t("docker.updates.none"),
          );
        }
      } catch (error) {
        if (refresh) {
          toast.error(getErrorMessage(error, t("docker.updates.checkFailed")));
        }
      } finally {
        setChecking(false);
      }
    },
    [docker, sessionId, t],
  );

  React.useEffect(() => {
    if (!sessionId || !active) return;
    void check(false);
    const timer = setInterval(() => void check(false), RECHECK_MS);
    return () => clearInterval(timer);
  }, [sessionId, active, check]);

  const update = React.useCallback(
    (container: DockerContainer) => {
      if (!sessionId) return;
      const name = container.name.replace(/^\//, "");
      setUpdating((current) => new Set(current).add(container.id));
      docker
        .updateContainer(sessionId, container.id)
        .then((result) => {
          toast.success(
            result.recreated
              ? t("docker.updates.updated", { name })
              : t("docker.updates.pulled", { name }),
          );
          onUpdated();
          void check(true);
        })
        .catch((error) =>
          toast.error(
            t("docker.updates.failed", {
              name,
              error: getErrorMessage(error),
            }),
          ),
        )
        .finally(() =>
          setUpdating((current) => {
            const next = new Set(current);
            next.delete(container.id);
            return next;
          }),
        );
    },
    [docker, sessionId, t, onUpdated, check],
  );

  const value = React.useMemo<UpdatesValue>(
    () => ({ statusOf: (image) => images[image], updating, update }),
    [images, updating, update],
  );
  const available = Object.values(images).filter(
    (item) => item.status === "update",
  ).length;
  return { value, check, checking, available };
}

export function UpdateBadge({
  image,
}: {
  image: string;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const { statusOf } = useUpdates();
  if (statusOf(image)?.status !== "update") return null;
  return (
    <span className="border border-blue-400/40 bg-blue-400/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-blue-400">
      {t("docker.updates.badge")}
    </span>
  );
}

/** The update button, shown only when the image has a newer version. */
export function UpdateButton({
  container,
}: {
  container: DockerContainer;
}): React.ReactElement | null {
  const { t } = useTranslation();
  const { statusOf, updating, update } = useUpdates();
  if (statusOf(container.image)?.status !== "update") return null;
  const busy = updating.has(container.id);
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="text-blue-400"
      disabled={busy}
      title={t("docker.updates.update")}
      aria-label={t("docker.updates.update")}
      onClick={(event) => {
        event.stopPropagation();
        update(container);
      }}
    >
      {busy ? (
        <RefreshCw className="size-3 animate-spin" />
      ) : (
        <ArrowUpCircle className="size-3" />
      )}
    </Button>
  );
}
