import React from "react";
import { Layers, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  AddButton,
  Button,
  FormFooter,
  InlineView,
  PanelSearch,
  PanelShell,
  Segmented,
  useAdaptivePolling,
} from "@termix-ssh/plugin-sdk/ui";
import { getErrorMessage } from "../error-message";
import { useDockerApi } from "../docker-api";
import type { DockerHost, StackSummary } from "../types";
import { StackDetail } from "./StackDetail";
import { StackStateBadge } from "./StackStateBadge";
import { COMPOSE_TEMPLATE, STACK_NAME_RE } from "./stack-utils";

interface StacksViewProps {
  sessionId: string;
  host: DockerHost;
  /** The Current | Manage switcher the Docker tab shows above the list. */
  switcher: React.ReactNode;
}

export function StacksView({
  sessionId,
  host,
  switcher,
}: StacksViewProps): React.ReactElement {
  const { t } = useTranslation();
  const docker = useDockerApi();
  const [stacks, setStacks] = React.useState<StackSummary[]>([]);
  const [root, setRoot] = React.useState("");
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const [selected, setSelected] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState("");
  const [newCompose, setNewCompose] = React.useState(COMPOSE_TEMPLATE);
  const [newEnv, setNewEnv] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const signatureRef = React.useRef("");

  const refresh = React.useCallback(async () => {
    try {
      const result = await docker.listStacks(sessionId);
      const signature = JSON.stringify(result);
      const changed = signature !== signatureRef.current;
      signatureRef.current = signature;
      setStacks(result.stacks);
      setRoot(result.root);
      setError(null);
      return changed;
    } catch (err) {
      setError(getErrorMessage(err, t("docker.stacks.listFailed")));
      return false;
    } finally {
      setLoaded(true);
    }
  }, [docker, sessionId, t]);

  useAdaptivePolling(
    refresh,
    { minIntervalMs: 5000, maxIntervalMs: 30000, stablePollsPerStep: 3 },
    !selected,
  );

  const nameValid = STACK_NAME_RE.test(newName);

  const create = async () => {
    setSaving(true);
    try {
      await docker.createStack(sessionId, {
        name: newName,
        compose: newCompose,
        env: newEnv || undefined,
      });
      toast.success(t("docker.stacks.created", { name: newName }));
      setCreating(false);
      setSelected(newName);
      setNewName("");
      setNewCompose(COMPOSE_TEMPLATE);
      setNewEnv("");
      void refresh();
    } catch (err) {
      toast.error(getErrorMessage(err, t("docker.stacks.createFailed")));
    } finally {
      setSaving(false);
    }
  };

  if (selected) {
    return (
      <StackDetail
        sessionId={sessionId}
        name={selected}
        host={host}
        onBack={() => {
          setSelected(null);
          void refresh();
        }}
        onChanged={() => void refresh()}
      />
    );
  }

  const needle = search.trim().toLowerCase();
  const visible = stacks.filter((stack) => {
    if (needle && !stack.name.includes(needle)) return false;
    if (filter === "all") return true;
    if (filter === "running") return stack.state === "running";
    if (filter === "stopped")
      return stack.state === "stopped" || stack.state === "paused";
    if (filter === "issues") return stack.state === "partial";
    return stack.state === "not-deployed";
  });

  const textClass =
    "w-full border border-border bg-background p-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring";

  return (
    <>
      <PanelShell
        icon={<Layers className="size-4" />}
        title={t("docker.stacks.title")}
        status={root || undefined}
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void refresh()}
              title={t("docker.refresh")}
              className="text-accent-brand"
            >
              <RefreshCw className="size-4" />
            </Button>
          </>
        }
        toolbar={
          <>
            {switcher}
            <PanelSearch
              value={search}
              onChange={setSearch}
              placeholder={t("docker.stacks.search")}
            />
            <AddButton
              label={t("docker.stacks.new")}
              onClick={() => setCreating(true)}
            />
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: t("docker.allStatuses") },
                { value: "running", label: t("docker.stateRunning") },
                { value: "stopped", label: t("docker.stacks.state.stopped") },
                { value: "issues", label: t("docker.stacks.state.partial") },
                {
                  value: "idle",
                  label: t("docker.stacks.state.not-deployed"),
                },
              ]}
            />
          </>
        }
        className="p-2.5 gap-2"
      >
        {!loaded ? (
          <div className="flex h-full flex-col items-center justify-center py-20 opacity-40">
            <RefreshCw className="mb-4 size-8 animate-spin" />
            <span className="text-sm font-semibold">
              {t("docker.stacks.loading")}
            </span>
          </div>
        ) : error ? (
          <p className="py-8 text-center text-sm text-destructive">{error}</p>
        ) : visible.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-muted-foreground">
              {stacks.length === 0
                ? t("docker.stacks.empty", { root })
                : t("docker.stacks.noMatches")}
            </p>
            {stacks.length === 0 && (
              <AddButton
                label={t("docker.stacks.new")}
                onClick={() => setCreating(true)}
              />
            )}
          </div>
        ) : (
          <div className="flex flex-col border border-border">
            {visible.map((stack) => (
              <button
                key={stack.name}
                type="button"
                onClick={() => setSelected(stack.name)}
                className="flex items-center gap-3 border-b border-border px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Layers className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">
                    {stack.name}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {stack.managed
                      ? t("docker.stacks.servicesRunning", {
                          running: stack.running,
                          total: stack.total,
                        })
                      : `${t("docker.stacks.external")} | ${t("docker.stacks.servicesRunning", { running: stack.running, total: stack.total })}`}
                  </div>
                </div>
                <StackStateBadge state={stack.state} />
              </button>
            ))}
          </div>
        )}
      </PanelShell>
      <InlineView
        open={creating}
        onOpenChange={setCreating}
        title={t("docker.stacks.new")}
        icon={<Layers className="size-4" />}
        footer={
          <FormFooter
            onCancel={() => setCreating(false)}
            onSave={() => void create()}
            saveLabel={t("docker.stacks.create")}
            cancelLabel={t("common.cancel")}
            saving={saving}
            disabled={!nameValid || !newCompose.trim()}
          />
        }
      >
        <div className="flex flex-col gap-3 p-3">
          <label className="flex flex-col gap-1 text-xs font-semibold">
            {t("docker.stacks.name")}
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="my-stack"
              spellCheck={false}
              className="h-8 border border-border bg-background px-2 font-mono text-xs font-normal focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <span className="font-normal text-muted-foreground">
              {newName && !nameValid
                ? t("docker.stacks.nameInvalid")
                : t("docker.stacks.nameHint", { root })}
            </span>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">
            {t("docker.stacks.compose")}
            <textarea
              value={newCompose}
              onChange={(event) => setNewCompose(event.target.value)}
              spellCheck={false}
              wrap="off"
              rows={14}
              className={textClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">
            {t("docker.stacks.envOptional")}
            <textarea
              value={newEnv}
              onChange={(event) => setNewEnv(event.target.value)}
              spellCheck={false}
              rows={5}
              placeholder="KEY=value"
              className={textClass}
            />
          </label>
        </div>
      </InlineView>
    </>
  );
}
