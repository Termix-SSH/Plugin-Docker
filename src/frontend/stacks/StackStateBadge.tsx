import React from "react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import type { StackState } from "../types";
import { stateClass } from "./stack-utils";

export function StackStateBadge({
  state,
}: {
  state: StackState;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <span
      className={`border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${stateClass(state)}`}
    >
      {t(`docker.stacks.state.${state}`)}
    </span>
  );
}
