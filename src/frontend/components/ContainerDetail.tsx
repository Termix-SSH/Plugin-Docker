import {
  BackButton,
  Button,
  PanelShell,
  TabStrip,
} from "@termix/plugin-sdk/ui";
import type { DockerContainer, DockerHost } from "../types";
import React from "react";
import { Activity, ArrowLeft, Box, List, Terminal } from "lucide-react";
import { useTranslation } from "@termix/plugin-sdk/frontend";
import { LogViewer } from "./LogViewer.tsx";
import { ContainerStats } from "./ContainerStats.tsx";
import { ConsoleTerminal } from "./ConsoleTerminal.tsx";
import { DockerBadge } from "./ContainerCard.tsx";

type DetailTab = "logs" | "stats" | "console";

interface ContainerDetailProps {
  sessionId: string;
  containerId: string;
  containers: DockerContainer[];
  hostConfig: DockerHost;
  onBack: () => void;
  initialTab?: DetailTab;
}

export function ContainerDetail({
  sessionId,
  containerId,
  containers,
  hostConfig,
  onBack,
  initialTab = "logs",
}: ContainerDetailProps): React.ReactElement {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = React.useState<DetailTab>(initialTab);

  React.useEffect(() => {
    setActiveTab(initialTab);
  }, [containerId, initialTab]);

  const container = containers.find((c) => c.id === containerId);
  const containerName = container
    ? container.name.startsWith("/")
      ? container.name.slice(1)
      : container.name
    : "";

  if (!container) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center flex flex-col gap-3">
          <p className="text-muted-foreground">
            {t("docker.containerNotFound")}
          </p>
          <Button onClick={onBack} variant="outline" size="sm">
            <ArrowLeft className="size-4 mr-2" />
            {t("docker.backToList")}
          </Button>
        </div>
      </div>
    );
  }

  const tabs: { id: DetailTab; label: string; icon: React.ReactNode }[] = [
    {
      id: "logs",
      label: t("docker.logs"),
      icon: <List className="size-3.5" />,
    },
    {
      id: "stats",
      label: t("docker.stats"),
      icon: <Activity className="size-3.5" />,
    },
    {
      id: "console",
      label: t("docker.consoleTab"),
      icon: <Terminal className="size-3.5" />,
    },
  ];

  return (
    <PanelShell
      leading={<BackButton onClick={onBack} label={t("docker.backToList")} />}
      icon={<Box className="size-4" />}
      title={containerName}
      status={container.image}
      actions={<DockerBadge state={container.state} />}
      tabs={
        <TabStrip
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={(id) => setActiveTab(id as DetailTab)}
        />
      }
      scroll={false}
      className="p-2.5"
    >
      {activeTab === "logs" && (
        <LogViewer
          sessionId={sessionId}
          containerId={containerId}
          containerName={containerName}
        />
      )}
      {activeTab === "stats" && (
        <ContainerStats
          sessionId={sessionId}
          containerId={containerId}
          containerName={containerName}
          containerState={container.state}
        />
      )}
      {activeTab === "console" && (
        <ConsoleTerminal
          containerId={containerId}
          containerName={containerName}
          containerState={container.state}
          hostConfig={hostConfig}
        />
      )}
    </PanelShell>
  );
}
