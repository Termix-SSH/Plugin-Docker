// The terminal surfaces need xterm's own stylesheet.
import "@xterm/xterm/css/xterm.css";
import { Box } from "lucide-react";
import type {
  StandaloneViewProps,
  TabProps,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { DockerManager } from "./DockerManager";
import DockerApp from "./DockerApp";
import { dockerWidget } from "./DockerWidget";
import { dockerEnabled, toDockerHost, type DockerHostSource } from "./types";
import { dockerPanelEnabled } from "./types";
import { DockerCompanion, useDockerCompanionDefaults } from "./DockerCompanion";
import { DockerHostsCard } from "./DockerHostsCard";

function DockerTab({ host, sshHost, label, isVisible }: TabProps) {
  const record = host ?? (sshHost as DockerHostSource | undefined);
  return (
    <DockerManager
      host={record ? toDockerHost(record) : undefined}
      title={label}
      isVisible={isVisible}
      isTopbarOpen={false}
      embedded={true}
    />
  );
}

function DockerStandalone({ hostId }: StandaloneViewProps) {
  return <DockerApp hostId={hostId} />;
}

export function activate(app: TermixApp): void {
  // Host actions filter synchronously, so the permission is read once here.
  let canUse = true;
  void app.hasPermission("use").then((allowed) => {
    canUse = allowed;
  });

  app.registerDashboardCard({
    id: "docker-hosts",
    titleKey: "card.title",
    defaultPanel: "side",
    defaultHeight: 220,
    frame: "framed",
    component: DockerHostsCard,
  });

  app.registerTab("docker", DockerTab, {
    icon: Box,
    titleKey: "nav.docker",
    requiresHost: true,
    noHostMessageKey: "docker.noHostSelected",
    persistent: true,
    activityTypes: ["docker"],
    standalone: DockerStandalone,
    preload: () => import("./DockerManager"),
  });

  app.registerCompanion("docker", DockerCompanion, {
    icon: Box,
    titleKey: "nav.docker",
    order: 30,
    tabTypes: ["terminal"],
    when: (_tab, host) =>
      canUse && !!host?.enableSsh && dockerPanelEnabled(host),
    useDefaults: useDockerCompanionDefaults,
  });

  app.registerAction("docker.togglePanel", ((_handle: unknown, tab: unknown) =>
    app.toggleCompanion(tab as never, "docker")) as never);
  app.registerSlotContribution("tab.menu", {
    actionId: "docker.togglePanel",
    titleKey: "nav.togglePanel",
    icon: Box,
    kind: "button",
    order: 6,
    when: (context) =>
      (context.tab as { type?: string } | null)?.type === "terminal",
  });

  app.registerHostAction({
    id: "docker",
    titleKey: "nav.docker",
    icon: Box,
    kind: "open",
    order: 30,
    tabType: "docker",
    copyUrlView: "docker",
    when: (host) => canUse && !!host.enableSsh && dockerEnabled(host),
  });

  app.registerExtension("homepage.widgets", dockerWidget);
}
