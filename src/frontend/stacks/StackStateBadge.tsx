import React from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import type { StackState } from "../types";
import { StatusBadge } from "@termix-ssh/plugin-sdk/ui";
import { stackTone } from "./stack-utils";

export function StackStateBadge({
  state,
}: {
  state: StackState;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <StatusBadge tone={stackTone(state)}>
      {t(`docker.stacks.state.${state}`)}
    </StatusBadge>
  );
}
