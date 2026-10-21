import React from "react";
import { Trash2 } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, cn } from "@termix-ssh/plugin-sdk/ui";

export interface StackEvent {
  id: number;
  time: number;
  level: "info" | "success" | "error";
  title: string;
  output?: string;
}

interface StackEventsProps {
  events: StackEvent[];
  onClear: () => void;
}

const levelClass: Record<StackEvent["level"], string> = {
  info: "bg-muted-foreground",
  success: "bg-accent-brand",
  error: "bg-destructive",
};

export function StackEvents({
  events,
  onClear,
}: StackEventsProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center">
        <span className="text-xs text-muted-foreground">
          {t("docker.stacks.eventsHint")}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={events.length === 0}
          onClick={onClear}
        >
          <Trash2 className="mr-1 size-4" />
          {t("docker.stacks.clearEvents")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto border border-border">
        {events.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t("docker.stacks.noEvents")}
          </p>
        ) : (
          events.map((event) => (
            <div
              key={event.id}
              className="border-b border-border px-3 py-2 last:border-b-0"
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn("size-2 shrink-0", levelClass[event.level])}
                />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {event.title}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {new Date(event.time).toLocaleTimeString()}
                </span>
              </div>
              {event.output?.trim() && (
                <details className="mt-1 pl-4">
                  <summary className="cursor-pointer text-xs text-muted-foreground">
                    {t("docker.stacks.showOutput")}
                  </summary>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all border border-border bg-background p-2 font-mono text-xs">
                    {event.output}
                  </pre>
                </details>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
