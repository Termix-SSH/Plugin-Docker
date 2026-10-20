import {
  useSettings,
  type CompanionDefaults,
  type CompanionProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { DockerManager } from "./DockerManager";
import { toDockerHost, type DockerHostSource } from "./types";

/** Starting state of the panel, from the user's settings. */
export function useDockerCompanionDefaults(): CompanionDefaults {
  const { values } = useSettings("user");
  const side = values.companionSide;
  return {
    open: values.companionAutoOpen === true,
    side: side === "left" || side === "bottom" ? side : "right",
    size: typeof values.companionSize === "number" ? values.companionSize : 380,
    edgeButton: values.companionEdgeButton !== false,
  };
}

export function DockerCompanion({
  host,
  sshHost,
  tab,
  isVisible,
  close,
}: CompanionProps) {
  const record = host ?? (sshHost as DockerHostSource | undefined);
  return (
    <DockerManager
      host={record ? toDockerHost(record) : undefined}
      title={tab.label}
      isVisible={isVisible}
      isTopbarOpen={false}
      embedded
      compact
      onClose={close}
    />
  );
}
