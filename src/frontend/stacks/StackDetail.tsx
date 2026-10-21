import React from "react";
import {
  Activity,
  FileText,
  KeyRound,
  Layers,
  List,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  BackButton,
  Button,
  FormFooter,
  PanelShell,
  TabStrip,
  useAdaptivePolling,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import { getErrorMessage } from "../error-message";
import { useDockerApi } from "../docker-api";
import { ConsoleTerminal } from "../components/ConsoleTerminal.tsx";
import type { DockerHost, StackAction, StackDetailData } from "../types";
import { EnvEditor } from "./EnvEditor";
import { StackEvents, type StackEvent } from "./StackEvents";
import { StackLogs } from "./StackLogs";
import { StackStateBadge } from "./StackStateBadge";
import { stateClass } from "./stack-utils";

type DetailTab =
  "overview" | "compose" | "env" | "logs" | "terminal" | "events";

interface StackDetailProps {
  sessionId: string;
  name: string;
  host: DockerHost;
  onBack: () => void;
  onChanged: () => void;
}

export function StackDetail({
  sessionId,
  name,
  host,
  onBack,
  onChanged,
}: StackDetailProps): React.ReactElement {
  const { t } = useTranslation();
  const docker = useDockerApi();
  const confirm = useConfirm();
  const [data, setData] = React.useState<StackDetailData | null>(null);
  const [tab, setTab] = React.useState<DetailTab>("overview");
  const [compose, setCompose] = React.useState("");
  const [env, setEnv] = React.useState("");
  const [savedCompose, setSavedCompose] = React.useState("");
  const [savedEnv, setSavedEnv] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [events, setEvents] = React.useState<StackEvent[]>([]);
  const eventId = React.useRef(0);
  const servicesRef = React.useRef<Map<string, string> | null>(null);

  const addEvent = React.useCallback(
    (level: StackEvent["level"], title: string, output?: string) => {
      eventId.current += 1;
      const event = {
        id: eventId.current,
        time: Date.now(),
        level,
        title,
        output,
      };
      setEvents((current) => [event, ...current].slice(0, 200));
    },
    [],
  );
  const [validation, setValidation] = React.useState<{
    valid: boolean;
    output: string;
  } | null>(null);
  const [logService, setLogService] = React.useState("");
  const [terminalService, setTerminalService] = React.useState("");
  const [missing, setMissing] = React.useState(false);

  const dirtyRef = React.useRef(false);
  const dirty = compose !== savedCompose || env !== savedEnv;
  dirtyRef.current = dirty;

  const load = React.useCallback(
    async (resetDrafts: boolean) => {
      try {
        const next = await docker.getStack(sessionId, name);
        setData(next);
        const states = new Map(next.services.map((s) => [s.service, s.state]));
        const before = servicesRef.current;
        if (before) {
          for (const [service, state] of states) {
            const was = before.get(service);
            if (was !== state) {
              addEvent(
                state === "running" ? "success" : "info",
                t("docker.stacks.eventState", {
                  service,
                  from: was ?? t("docker.stacks.notCreated"),
                  to: state,
                }),
              );
            }
          }
          for (const service of before.keys()) {
            if (!states.has(service)) {
              addEvent("info", t("docker.stacks.eventRemoved", { service }));
            }
          }
        }
        servicesRef.current = states;
        if (resetDrafts || !dirtyRef.current) {
          setCompose(next.compose ?? "");
          setEnv(next.env ?? "");
          setSavedCompose(next.compose ?? "");
          setSavedEnv(next.env ?? "");
        }
        return true;
      } catch (error) {
        if ((error as { status?: number }).status === 404) setMissing(true);
        else toast.error(getErrorMessage(error, t("docker.stacks.loadFailed")));
        return false;
      }
    },
    [docker, sessionId, name, t, addEvent],
  );

  React.useEffect(() => {
    setData(null);
    setEvents([]);
    servicesRef.current = null;
    setMissing(false);
    setTab("overview");
    void load(true);
  }, [load]);

  useAdaptivePolling(
    async () => {
      const before = JSON.stringify(data?.services);
      await load(false);
      return before !== JSON.stringify(data?.services);
    },
    { minIntervalMs: 5000, maxIntervalMs: 30000, stablePollsPerStep: 3 },
    !!data && !busy,
  );

  const run = async (
    action: StackAction,
    service?: string,
    extra: { removeVolumes?: boolean; removeFiles?: boolean } = {},
  ) => {
    setBusy(service ? `${action}:${service}` : action);
    try {
      const result = await docker.stackAction(sessionId, name, {
        action,
        service,
        ...extra,
      });
      addEvent(
        "success",
        t(`docker.stacks.event.${action}`, { name, service: service ?? name }),
        result.output,
      );
      toast.success(t(`docker.stacks.done.${action}`, { name }));
      if (action === "destroy" && extra.removeFiles) {
        onChanged();
        onBack();
        return;
      }
      await load(false);
      onChanged();
    } catch (error) {
      const message = getErrorMessage(error, t("docker.stacks.actionFailed"));
      addEvent(
        "error",
        t("docker.stacks.eventFailed", {
          action: t(`docker.stacks.event.${action}`, {
            name,
            service: service ?? name,
          }),
        }),
        message,
      );
      toast.error(t("docker.stacks.actionFailed"));
    } finally {
      setBusy(null);
    }
  };

  const ask = async (action: "down" | "destroy") => {
    const ok = await confirm({
      title: t(`docker.stacks.confirm.${action}`, { name }),
      confirmLabel: t(`docker.stacks.${action}`),
      cancelLabel: t("common.cancel"),
    });
    if (!ok) return;
    if (action === "down") return run("down");
    const removeFiles = await confirm({
      title: t("docker.stacks.confirm.deleteFiles", { name }),
      confirmLabel: t("docker.stacks.deleteFiles"),
      cancelLabel: t("docker.stacks.keepFiles"),
    });
    await run("destroy", undefined, { removeVolumes: true, removeFiles });
  };

  const save = async (deployAfter: boolean) => {
    setBusy("save");
    try {
      if (compose !== savedCompose) {
        await docker.saveStackFile(sessionId, name, "compose", compose);
        setSavedCompose(compose);
      }
      if (env !== savedEnv) {
        await docker.saveStackFile(sessionId, name, "env", env);
        setSavedEnv(env);
      }
      toast.success(t("docker.stacks.saved"));
    } catch (error) {
      toast.error(getErrorMessage(error, t("docker.stacks.saveFailed")));
      setBusy(null);
      return;
    }
    setBusy(null);
    if (deployAfter) await run("deploy");
    else await load(false);
  };

  const validate = async () => {
    setBusy("validate");
    try {
      setValidation(await docker.validateStack(sessionId, compose, name));
    } catch (error) {
      toast.error(getErrorMessage(error, t("docker.stacks.validateFailed")));
    } finally {
      setBusy(null);
    }
  };

  if (missing) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-muted-foreground">{t("docker.stacks.notFound")}</p>
        <Button variant="outline" size="sm" onClick={onBack}>
          {t("docker.backToList")}
        </Button>
      </div>
    );
  }

  const managed = data?.managed ?? false;
  const tabs: { id: DetailTab; label: string; icon: React.ReactNode }[] = [
    {
      id: "overview",
      label: t("docker.stacks.overview"),
      icon: <Layers className="size-3.5" />,
    },
    ...(managed
      ? [
          {
            id: "compose" as const,
            label: t("docker.stacks.compose"),
            icon: <FileText className="size-3.5" />,
          },
          {
            id: "env" as const,
            label: t("docker.stacks.env"),
            icon: <KeyRound className="size-3.5" />,
          },
        ]
      : []),
    {
      id: "events",
      label: t("docker.stacks.events"),
      icon: <Activity className="size-3.5" />,
    },
    {
      id: "logs",
      label: t("docker.logs"),
      icon: <List className="size-3.5" />,
    },
    {
      id: "terminal",
      label: t("docker.consoleTab"),
      icon: <Terminal className="size-3.5" />,
    },
  ];

  const isBusy = busy !== null;
  const services = data?.services ?? [];
  const serviceNames = Array.from(
    new Set([
      ...(data?.declaredServices ?? []),
      ...services.map((item) => item.service),
    ]),
  );
  const runningServices = services.filter((item) => item.state === "running");
  const activeTerminal =
    runningServices.find((item) => item.service === terminalService) ??
    runningServices[0];

  const actionButton = (
    action: StackAction,
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
  ) => (
    <Button
      variant="ghost"
      size="sm"
      disabled={isBusy}
      onClick={onClick ?? (() => void run(action))}
      title={label}
    >
      {busy === action ? (
        <RefreshCw className="mr-1 size-4 animate-spin" />
      ) : (
        icon
      )}
      <span className="hidden xl:inline">{label}</span>
    </Button>
  );

  return (
    <PanelShell
      leading={<BackButton onClick={onBack} label={t("docker.backToList")} />}
      icon={<Layers className="size-4" />}
      title={name}
      status={
        data
          ? t("docker.stacks.servicesRunning", {
              running: data.running,
              total: data.total,
            })
          : undefined
      }
      actions={
        <>
          {data && <StackStateBadge state={data.state} />}
          {actionButton(
            "deploy",
            <UploadCloud className="mr-1 size-4" />,
            t("docker.stacks.deploy"),
          )}
          {actionButton(
            "restart",
            <RotateCw className="mr-1 size-4" />,
            t("docker.restart"),
          )}
          {actionButton(
            data?.state === "paused" ? "unpause" : "pause",
            data?.state === "paused" ? (
              <Play className="mr-1 size-4" />
            ) : (
              <Pause className="mr-1 size-4" />
            ),
            data?.state === "paused" ? t("docker.resume") : t("docker.pause"),
          )}
          {actionButton(
            "stop",
            <Square className="mr-1 size-4" />,
            t("docker.stop"),
          )}
          {actionButton(
            "destroy",
            <Trash2 className="mr-1 size-4 text-destructive" />,
            t("docker.stacks.destroy"),
            () => void ask("destroy"),
          )}
        </>
      }
      tabs={
        <TabStrip
          tabs={tabs}
          activeTab={tab}
          onTabChange={(id) => setTab(id as DetailTab)}
        />
      }
      scroll={false}
      className="p-2.5"
    >
      {!data ? (
        <div className="flex h-full items-center justify-center opacity-40">
          <RefreshCw className="size-6 animate-spin" />
        </div>
      ) : tab === "overview" ? (
        <div className="flex h-full min-h-0 flex-col gap-2 overflow-auto">
          <div className="flex flex-wrap gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => void run("redeploy")}
            >
              {t("docker.stacks.redeploy")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => void run("pull")}
            >
              {t("docker.stacks.pull")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => void ask("down")}
            >
              {t("docker.stacks.down")}
            </Button>
          </div>
          {services.length === 0 && serviceNames.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t("docker.stacks.noServices")}
            </p>
          ) : (
            <div className="flex flex-col border border-border">
              {serviceNames.map((service) => {
                const item = services.find(
                  (entry) => entry.service === service,
                );
                return (
                  <div
                    key={service}
                    className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5 last:border-b-0"
                  >
                    <div className="min-w-[10rem] flex-1">
                      <div className="text-sm font-semibold">{service}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {item
                          ? `${item.image} | ${item.status}`
                          : t("docker.stacks.notCreated")}
                      </div>
                    </div>
                    {item?.ports && (
                      <span className="font-mono text-xs text-muted-foreground">
                        {item.ports}
                      </span>
                    )}
                    <span
                      className={`border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${stateClass(item?.health || item?.state || "")}`}
                    >
                      {item
                        ? item.health || item.state
                        : t("docker.stacks.notCreated")}
                    </span>
                    <div className="flex items-center">
                      {item?.state === "running" ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={isBusy}
                          title={t("docker.stop")}
                          onClick={() => void run("stop", service)}
                        >
                          <Square className="size-4" />
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={isBusy}
                          title={t("docker.start")}
                          onClick={() =>
                            void run(item ? "start" : "deploy", service)
                          }
                        >
                          <Play className="size-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={isBusy || !item}
                        title={t("docker.restart")}
                        onClick={() => void run("restart", service)}
                      >
                        <RotateCw className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={isBusy}
                        title={t("docker.stacks.pull")}
                        onClick={() => void run("pull", service)}
                      >
                        <UploadCloud className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t("docker.logs")}
                        onClick={() => {
                          setLogService(service);
                          setTab("logs");
                        }}
                      >
                        <List className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={item?.state !== "running"}
                        title={t("docker.consoleTab")}
                        onClick={() => {
                          setTerminalService(service);
                          setTab("terminal");
                        }}
                      >
                        <Terminal className="size-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : tab === "compose" || tab === "env" ? (
        <div className="flex h-full min-h-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {tab === "compose" && (
              <Button
                variant="ghost"
                size="sm"
                disabled={isBusy}
                onClick={() => void validate()}
              >
                <ShieldCheck className="mr-1 size-4" />
                {t("docker.stacks.validate")}
              </Button>
            )}
            {data.composeFile && (
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {data.composeFile}
              </span>
            )}
          </div>
          {tab === "compose" ? (
            <>
              <textarea
                value={compose}
                onChange={(event) => {
                  setCompose(event.target.value);
                  setValidation(null);
                }}
                onKeyDown={(event) => {
                  const area = event.currentTarget;
                  if (event.key === "Tab") {
                    event.preventDefault();
                    const { selectionStart: start, selectionEnd: end } = area;
                    const next = `${compose.slice(0, start)}  ${compose.slice(end)}`;
                    setCompose(next);
                    requestAnimationFrame(() => {
                      area.selectionStart = area.selectionEnd = start + 2;
                    });
                  } else if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === "s"
                  ) {
                    event.preventDefault();
                    if (dirty && !isBusy) void save(false);
                  }
                }}
                spellCheck={false}
                wrap="off"
                aria-label={t("docker.stacks.compose")}
                className="min-h-0 flex-1 resize-none border border-border bg-background p-2 font-mono text-xs leading-5 focus:outline-none focus:ring-1 focus:ring-ring"
              />
              {validation && (
                <pre
                  className={`max-h-32 overflow-auto whitespace-pre-wrap border p-2 font-mono text-xs ${
                    validation.valid
                      ? "border-accent-brand/40 text-accent-brand"
                      : "border-destructive/40 text-destructive"
                  }`}
                >
                  {validation.valid
                    ? t("docker.stacks.valid")
                    : validation.output || t("docker.stacks.invalid")}
                </pre>
              )}
            </>
          ) : (
            <div className="min-h-0 flex-1">
              <EnvEditor value={env} onChange={setEnv} />
            </div>
          )}
          <FormFooter
            onSave={() => void save(false)}
            saveLabel={t("common.save")}
            saving={busy === "save"}
            dirty={dirty}
            disabled={isBusy || !dirty}
            extra={
              <Button
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => void save(true)}
              >
                <UploadCloud className="mr-1 size-4" />
                {t("docker.stacks.saveDeploy")}
              </Button>
            }
          />
        </div>
      ) : tab === "events" ? (
        <StackEvents events={events} onClear={() => setEvents([])} />
      ) : tab === "logs" ? (
        <StackLogs
          sessionId={sessionId}
          name={name}
          services={serviceNames}
          initialService={logService}
        />
      ) : activeTerminal ? (
        <div className="flex h-full min-h-0 flex-col gap-2">
          <select
            value={activeTerminal.service}
            onChange={(event) => setTerminalService(event.target.value)}
            aria-label={t("docker.stacks.service")}
            className="h-8 w-fit border border-border bg-background px-2 text-xs"
          >
            {runningServices.map((item) => (
              <option key={item.id} value={item.service}>
                {item.service}
              </option>
            ))}
          </select>
          <div className="min-h-0 flex-1">
            <ConsoleTerminal
              key={activeTerminal.id}
              containerId={activeTerminal.id}
              containerName={activeTerminal.service}
              containerState={activeTerminal.state}
              hostConfig={host}
            />
          </div>
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t("docker.stacks.noRunning")}
        </p>
      )}
    </PanelShell>
  );
}
