/* eslint-disable react-hooks/exhaustive-deps */
import React from "react";
import { Box, ExternalLink, RefreshCw } from "lucide-react";
import {
  useConnectionRetry,
  useHost,
  useTranslation,
  logActivity,
  usePluginUiPreferences,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  Button,
  ConnectionLogProvider,
  ConnectionScreen,
  PanelSearch,
  PanelShell,
  Segmented,
  ViewToggle,
  SSHAuthDialog,
  TOTPDialog,
  BrowserSignInDialog,
  useAdaptivePolling,
  useConnectionLog,
  useTabsSafe,
} from "@termix-ssh/plugin-sdk/ui";
import { DockerApiError, useDockerApi, type ConnectResult } from "./docker-api";
import {
  dockerEnabled,
  hostTitle,
  toDockerHost,
  type DockerContainer,
  type DockerHost,
  type DockerValidation,
} from "./types";
import { ContainerList } from "./components/ContainerList.tsx";
import { ContainerTable } from "./components/ContainerTable.tsx";
import { ContainerDetail } from "./components/ContainerDetail.tsx";

interface DockerManagerProps {
  host?: DockerHost;
  title?: string;
  isVisible?: boolean;
  isTopbarOpen?: boolean;
  embedded?: boolean;
  onClose?: () => void;
}

interface PromptState {
  kind: "totp" | "browser";
  sessionId: string;
  prompt?: string;
  isPassword?: boolean;
  url?: string;
  code?: string;
  label?: string;
}

function newSessionId(): string {
  return `docker-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function DockerManagerInner({
  host,
  title,
  isVisible = true,
  isTopbarOpen = true,
  embedded = false,
  onClose,
}: DockerManagerProps): React.ReactElement {
  const { t } = useTranslation();
  const docker = useDockerApi();
  const { addLog, setLogs, clearLogs } = useConnectionLog();
  const { currentTab, removeTab } = useTabsSafe();
  const { values: dockerPrefs, set: setDockerPref } = usePluginUiPreferences<{
    viewMode: "list" | "detail";
    containerLayout: "card" | "table";
  }>();

  // The shell's host list keeps the host current after an edit; a
  // standalone window has no shell, so it keeps the host it was given.
  const liveRecord = useHost(host?.id);
  const currentHost = React.useMemo(
    () => (liveRecord ? toDockerHost(liveRecord) : host),
    [liveRecord, host],
  );
  const enabled = dockerEnabled(currentHost);

  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [containers, setContainers] = React.useState<DockerContainer[]>([]);
  const containersSignatureRef = React.useRef("");
  const [selectedContainer, setSelectedContainer] = React.useState<
    string | null
  >(null);
  const [detailInitialTab, setDetailInitialTab] = React.useState<
    "logs" | "stats" | "console"
  >("logs");
  const [containerLayout, setContainerLayout] = React.useState<
    "card" | "table"
  >(dockerPrefs.containerLayout);

  const handleSetContainerLayout = React.useCallback(
    (layout: "card" | "table") => {
      setContainerLayout(layout);
      setDockerPref("containerLayout", layout);
    },
    [setDockerPref],
  );
  const [isConnecting, setIsConnecting] = React.useState(false);
  const [dockerValidation, setDockerValidation] =
    React.useState<DockerValidation | null>(null);
  const [isValidating, setIsValidating] = React.useState(false);
  // Initial view follows the interface preset; switching it afterwards is a
  // per-session choice.
  const [viewMode, setViewMode] = React.useState<"list" | "detail">(
    dockerPrefs.viewMode,
  );
  const [isLoadingContainers, setIsLoadingContainers] = React.useState(false);
  const [hasLoadedContainersOnce, setHasLoadedContainersOnce] =
    React.useState(false);
  const [prompt, setPrompt] = React.useState<PromptState | null>(null);
  const [showAuthDialog, setShowAuthDialog] = React.useState(false);
  const [authReason, setAuthReason] = React.useState<
    "no_keyboard" | "auth_failed" | "timeout"
  >("no_keyboard");
  const [search, setSearch] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [retryCount, setRetryCount] = React.useState(0);

  const activityLoggedRef = React.useRef(false);

  const logDockerActivity = () => {
    if (!currentHost?.id || activityLoggedRef.current) return;
    activityLoggedRef.current = true;
    logActivity("docker", currentHost.id, hostTitle(currentHost)).catch(() => {
      activityLoggedRef.current = false;
    });
  };

  React.useEffect(() => {
    setContainers([]);
    setSelectedContainer(null);
    setSessionId(null);
    setDockerValidation(null);
    setViewMode("list");
  }, [host?.id]);

  const retryRef = React.useRef<ReturnType<typeof useConnectionRetry> | null>(
    null,
  );

  const validate = async (sid: string, clearAfter: boolean) => {
    setSessionId(sid);
    setIsValidating(true);
    try {
      const validation = await docker.validate(sid);
      setDockerValidation(validation);
      if (!validation.available) {
        addLog({
          type: "error",
          stage: "validation",
          message: validation.error || t("docker.error"),
          details: validation.code
            ? `Error code: ${validation.code}`
            : undefined,
        });
        retryRef.current?.markFailed();
      } else {
        logDockerActivity();
        if (clearAfter) setTimeout(() => clearLogs(), 1000);
        retryRef.current?.markConnected();
      }
    } finally {
      setIsValidating(false);
    }
  };

  /** Acts on one step of a connect, whichever request it answered. */
  const applyConnectResult = async (
    sid: string,
    result: ConnectResult,
    clearAfter: boolean,
  ) => {
    if (result.connectionLogs) setLogs(result.connectionLogs);

    if (result.requires_browser_sign_in) {
      setPrompt({
        kind: "browser",
        sessionId: sid,
        url: result.url || "",
        code: result.code || "",
        label: result.label || "",
      });
      return;
    }
    if (result.requires_totp) {
      if (result.retry) {
        addLog({
          type: "error",
          stage: "auth",
          message: t("docker.totpVerificationFailed"),
        });
      }
      setPrompt({
        kind: "totp",
        sessionId: sid,
        prompt: result.prompt || t("docker.verificationCodePrompt"),
        isPassword: result.isPassword,
      });
      return;
    }
    if (result.status === "auth_required") {
      setAuthReason(
        result.reason === "no_keyboard" ? "no_keyboard" : "auth_failed",
      );
      setShowAuthDialog(true);
      return;
    }
    setPrompt(null);
    await validate(sid, clearAfter);
  };

  const reportFailure = (error: unknown, fallback: string) => {
    if (error instanceof DockerApiError && error.connectionLogs?.length) {
      setLogs(error.connectionLogs);
    } else {
      addLog({
        type: "error",
        stage: "connection",
        message: error instanceof Error ? error.message : fallback,
      });
    }
    retryRef.current?.markFailed();
  };

  const connect = async (credentials?: {
    userProvidedPassword?: string;
    userProvidedSshKey?: string;
    userProvidedKeyPassword?: string;
  }) => {
    if (!currentHost?.id) return;
    const sid = newSessionId();
    setIsConnecting(true);
    try {
      const result = await docker.connect(sid, currentHost.id, credentials);
      await applyConnectResult(sid, result, !credentials);
    } catch (error) {
      reportFailure(error, t("docker.connectionFailed"));
    } finally {
      setIsConnecting(false);
    }
  };

  const initializingRef = React.useRef(false);

  React.useEffect(() => {
    if (!currentHost?.id || !enabled) return;
    if (initializingRef.current || sessionId) return;
    initializingRef.current = true;
    clearLogs();
    void connect();

    return () => {
      initializingRef.current = false;
    };
  }, [currentHost?.id, enabled, retryCount]);

  React.useEffect(() => {
    if (!sessionId) return;
    return () => {
      docker.disconnect(sessionId).catch(() => {});
    };
  }, [sessionId]);

  React.useEffect(() => {
    if (!sessionId || !isVisible) return;
    const keepalive = setInterval(
      () => {
        docker.keepalive(sessionId).catch(() => {});
      },
      10 * 60 * 1000,
    );
    return () => clearInterval(keepalive);
  }, [sessionId, isVisible]);

  const refreshContainers = React.useCallback(async () => {
    if (!sessionId) return;
    try {
      setContainers(await docker.listContainers(sessionId, true));
    } catch {
      // the next poll tries again
    }
  }, [sessionId, docker]);

  React.useEffect(() => {
    setHasLoadedContainersOnce(false);
  }, [sessionId]);

  useAdaptivePolling(
    async () => {
      if (!sessionId) return;
      setIsLoadingContainers((loading) =>
        hasLoadedContainersOnce ? loading : true,
      );
      const data = await docker.listContainers(sessionId, true);
      const signature = JSON.stringify(data);
      const changed = signature !== containersSignatureRef.current;
      containersSignatureRef.current = signature;
      setContainers(data);
      setIsLoadingContainers(false);
      setHasLoadedContainersOnce(true);
      return changed;
    },
    {
      minIntervalMs: 5000,
      maxIntervalMs: 30000,
      stablePollsPerStep: 3,
    },
    !!sessionId && isVisible && !!dockerValidation?.available,
    {
      onError: () => {
        setIsLoadingContainers(false);
        setHasLoadedContainersOnce(true);
      },
    },
  );

  const handleBack = React.useCallback(() => {
    setViewMode("list");
    setSelectedContainer(null);
  }, []);

  const closeTab = () => {
    if (currentTab !== null) removeTab(currentTab);
  };

  const handleTotpSubmit = async (code: string) => {
    if (!prompt || prompt.kind !== "totp" || !code) return;
    const sid = prompt.sessionId;
    setPrompt(null);
    setIsConnecting(true);
    try {
      await applyConnectResult(sid, await docker.answerTotp(sid, code), false);
    } catch (error) {
      reportFailure(error, t("docker.totpVerificationFailed"));
    } finally {
      setIsConnecting(false);
    }
  };

  const handleBrowserSignInContinue = async () => {
    if (!prompt || prompt.kind !== "browser") return;
    const sid = prompt.sessionId;
    setPrompt(null);
    setIsConnecting(true);
    try {
      await applyConnectResult(
        sid,
        await docker.continueBrowserSignIn(sid),
        false,
      );
    } catch (error) {
      reportFailure(error, t("docker.browserSignInFailed"));
    } finally {
      setIsConnecting(false);
    }
  };

  const handlePromptCancel = () => {
    const sid = prompt?.sessionId;
    setPrompt(null);
    setIsConnecting(false);
    if (sid) docker.disconnect(sid).catch(() => {});
    closeTab();
  };

  const handleBrowserSignInOpenUrl = () => {
    if (prompt?.url) window.open(prompt.url, "_blank", "noopener,noreferrer");
  };

  const handleAuthSubmit = async (credentials: {
    password?: string;
    sshKey?: string;
    keyPassword?: string;
  }) => {
    setShowAuthDialog(false);
    await connect({
      userProvidedPassword: credentials.password,
      userProvidedSshKey: credentials.sshKey,
      userProvidedKeyPassword: credentials.keyPassword,
    });
  };

  const handleAuthCancel = () => {
    setShowAuthDialog(false);
    setIsConnecting(false);
    onClose?.();
  };

  const handleRetry = () => {
    initializingRef.current = false;
    setSessionId(null);
    setDockerValidation(null);
    clearLogs();
    setRetryCount((c) => c + 1);
  };

  const dockerConnectRetry = useConnectionRetry({
    connect: () => {
      handleRetry();
    },
    enabled: enabled && !prompt && !showAuthDialog,
    autoStart: false,
  });
  retryRef.current = dockerConnectRetry;

  const topMarginPx = isTopbarOpen ? 74 : 16;
  const leftMarginPx = 8;
  const bottomMarginPx = 8;

  const wrapperStyle: React.CSSProperties = embedded
    ? { opacity: isVisible ? 1 : 0, height: "100%", width: "100%" }
    : {
        opacity: isVisible ? 1 : 0,
        marginLeft: leftMarginPx,
        marginRight: 17,
        marginTop: topMarginPx,
        marginBottom: bottomMarginPx,
        height: `calc(100vh - ${topMarginPx + bottomMarginPx}px)`,
      };

  const containerClass = embedded
    ? "h-full w-full text-foreground overflow-hidden bg-transparent"
    : "bg-canvas text-foreground border-2 border-edge overflow-hidden";

  if (!enabled) {
    return (
      <div style={wrapperStyle} className={`${containerClass} relative`}>
        <ConnectionScreen
          status="error"
          message={title}
          unavailable={{
            title: t("docker.notEnabled"),
            hint: t("docker.notEnabledHint"),
          }}
        />
      </div>
    );
  }

  const dialogs = (
    <>
      <TOTPDialog
        isOpen={prompt?.kind === "totp"}
        prompt={prompt?.prompt ?? ""}
        mode={prompt?.isPassword ? "password" : "totp"}
        onSubmit={handleTotpSubmit}
        onCancel={handlePromptCancel}
      />
      <BrowserSignInDialog
        isOpen={prompt?.kind === "browser"}
        label={prompt?.label ?? ""}
        url={prompt?.url ?? ""}
        code={prompt?.code ?? ""}
        onContinue={handleBrowserSignInContinue}
        onCancel={handlePromptCancel}
        onOpenUrl={handleBrowserSignInOpenUrl}
      />
      {currentHost && (
        <SSHAuthDialog
          isOpen={showAuthDialog}
          reason={authReason}
          onSubmit={handleAuthSubmit}
          onCancel={handleAuthCancel}
          hostInfo={{
            ip: currentHost.ip,
            port: currentHost.port,
            username: currentHost.username ?? "",
            name: currentHost.name,
          }}
        />
      )}
    </>
  );

  const hostDetail = currentHost
    ? `${currentHost.username ? currentHost.username + "@" : ""}${currentHost.ip}:${currentHost.port}`
    : undefined;

  if (isConnecting || isValidating) {
    return (
      <div style={wrapperStyle} className={`${containerClass} relative`}>
        <ConnectionScreen
          status={dockerConnectRetry.status}
          message={
            isValidating ? t("docker.validating") : t("docker.connecting")
          }
          detail={hostDetail}
          attempt={dockerConnectRetry.attempt}
          maxAttempts={dockerConnectRetry.maxAttempts}
          nextRetryInMs={dockerConnectRetry.nextRetryInMs}
          onManualRetry={dockerConnectRetry.retryNow}
        />
        {dialogs}
      </div>
    );
  }

  if (dockerValidation && !dockerValidation.available) {
    return (
      <div style={wrapperStyle} className={`${containerClass} relative`}>
        <ConnectionScreen
          status={dockerConnectRetry.status}
          message={t("docker.connecting")}
          detail={hostDetail}
          errorDetail={dockerValidation.error || t("docker.error")}
          attempt={dockerConnectRetry.attempt}
          maxAttempts={dockerConnectRetry.maxAttempts}
          nextRetryInMs={dockerConnectRetry.nextRetryInMs}
          onManualRetry={dockerConnectRetry.retryNow}
          logPosition="top"
        />
      </div>
    );
  }

  return (
    <div style={wrapperStyle} className={`${containerClass} relative`}>
      <div className="h-full w-full flex flex-col flex-1 min-h-0 overflow-hidden">
        {viewMode === "detail" &&
        sessionId &&
        selectedContainer &&
        currentHost ? (
          <ContainerDetail
            sessionId={sessionId}
            containerId={selectedContainer}
            containers={containers}
            hostConfig={currentHost}
            onBack={handleBack}
            initialTab={detailInitialTab}
          />
        ) : (
          <PanelShell
            icon={<Box className="size-4" />}
            title={title}
            status={
              dockerValidation?.version
                ? t("docker.version", {
                    runtime:
                      dockerValidation.runtime === "podman"
                        ? "Podman"
                        : "Docker",
                    version: dockerValidation.version,
                  })
                : t("docker.manager")
            }
            actions={
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={refreshContainers}
                  disabled={isLoadingContainers}
                  title={t("docker.refresh")}
                  className="text-accent-brand"
                >
                  <RefreshCw
                    className={`size-4 ${isLoadingContainers ? "animate-spin" : ""}`}
                  />
                </Button>
                <a
                  href="https://docs.termix.site/features/networking/docker"
                  target="_blank"
                  rel="noreferrer"
                  className="flex size-8 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                  title={t("hosts.docsLink")}
                >
                  <ExternalLink className="size-4" />
                </a>
              </>
            }
            toolbar={
              <>
                <PanelSearch
                  value={search}
                  onChange={setSearch}
                  placeholder={t("docker.searchPlaceholder")}
                />
                <Segmented
                  value={statusFilter}
                  onChange={setStatusFilter}
                  options={[
                    { value: "all", label: t("docker.allStatuses") },
                    { value: "running", label: t("docker.stateRunning") },
                    { value: "paused", label: t("docker.statePaused") },
                    { value: "exited", label: t("docker.stateExited") },
                    { value: "restarting", label: t("docker.stateRestarting") },
                  ]}
                />
                <div className="ml-auto flex items-center gap-2">
                  <ViewToggle
                    view={containerLayout === "table" ? "list" : "grid"}
                    onView={(next) =>
                      handleSetContainerLayout(
                        next === "list" ? "table" : "card",
                      )
                    }
                  />
                </div>
              </>
            }
            className="p-2.5 gap-2"
          >
            {sessionId ? (
              !hasLoadedContainersOnce ? (
                <div className="flex flex-col items-center justify-center h-full opacity-40 py-20">
                  <RefreshCw className="size-8 animate-spin mb-4" />
                  <span className="text-sm font-semibold">
                    {t("docker.loadingContainers")}
                  </span>
                </div>
              ) : containerLayout === "table" ? (
                <ContainerTable
                  containers={containers}
                  sessionId={sessionId}
                  onSelectContainer={(id, tab) => {
                    setSelectedContainer(id);
                    setDetailInitialTab(tab ?? "logs");
                    setViewMode("detail");
                  }}
                  selectedContainerId={selectedContainer}
                  onRefresh={refreshContainers}
                  search={search}
                  statusFilter={statusFilter}
                />
              ) : (
                <ContainerList
                  containers={containers}
                  sessionId={sessionId}
                  onSelectContainer={(id) => {
                    setSelectedContainer(id);
                    setDetailInitialTab("logs");
                    setViewMode("detail");
                  }}
                  selectedContainerId={selectedContainer}
                  onRefresh={refreshContainers}
                  search={search}
                  statusFilter={statusFilter}
                />
              )
            ) : null}
          </PanelShell>
        )}
      </div>
      {dialogs}
      <ConnectionScreen
        status={dockerConnectRetry.status}
        message={t("docker.connecting")}
        attempt={dockerConnectRetry.attempt}
        maxAttempts={dockerConnectRetry.maxAttempts}
        nextRetryInMs={dockerConnectRetry.nextRetryInMs}
        onManualRetry={dockerConnectRetry.retryNow}
        logPosition="top"
      />
    </div>
  );
}

export function DockerManager(props: DockerManagerProps): React.ReactElement {
  return (
    <ConnectionLogProvider>
      <DockerManagerInner {...props} />
    </ConnectionLogProvider>
  );
}
