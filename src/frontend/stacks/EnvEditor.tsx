import React from "react";
import { Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, Segmented } from "@termix-ssh/plugin-sdk/ui";
import { parseEnv, serializeEnv } from "./stack-utils";

interface EnvEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function EnvEditor({
  value,
  onChange,
}: EnvEditorProps): React.ReactElement {
  const { t } = useTranslation();
  const [mode, setMode] = React.useState<"table" | "raw">("table");
  const [revealed, setRevealed] = React.useState<Set<number>>(new Set());
  const [lines, setLines] = React.useState(() => parseEnv(value));

  // Rows with an empty name live only here until they get one.
  React.useEffect(() => {
    if (value !== serializeEnv(lines)) setLines(parseEnv(value));
  }, [value]);

  const update = (next: typeof lines) => {
    setLines(next);
    onChange(serializeEnv(next));
  };

  const toggle = (index: number) =>
    setRevealed((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const inputClass =
    "h-8 w-full border border-border bg-background px-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring";

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Segmented
          value={mode}
          onChange={(next) => setMode(next as "table" | "raw")}
          options={[
            { value: "table", label: t("docker.stacks.envTable") },
            { value: "raw", label: t("docker.stacks.envRaw") },
          ]}
        />
        {mode === "table" && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() =>
              update([...lines, { kind: "kv", key: "", value: "" }])
            }
          >
            <Plus className="mr-1 size-4" />
            {t("docker.stacks.addVariable")}
          </Button>
        )}
      </div>
      {mode === "raw" ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none border border-border bg-background p-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring"
          aria-label={t("docker.stacks.envRaw")}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {lines.every((line) => line.kind === "raw") && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("docker.stacks.noVariables")}
            </p>
          )}
          <div className="flex flex-col gap-1">
            {lines.map((line, index) =>
              line.kind === "kv" ? (
                <div key={index} className="flex items-center gap-1">
                  <input
                    value={line.key}
                    onChange={(event) =>
                      update(
                        lines.map((item, i) =>
                          i === index
                            ? { ...line, key: event.target.value }
                            : item,
                        ),
                      )
                    }
                    placeholder={t("docker.stacks.variableName")}
                    spellCheck={false}
                    className={`${inputClass} max-w-[16rem]`}
                  />
                  <input
                    value={line.value}
                    type={revealed.has(index) ? "text" : "password"}
                    onChange={(event) =>
                      update(
                        lines.map((item, i) =>
                          i === index
                            ? { ...line, value: event.target.value }
                            : item,
                        ),
                      )
                    }
                    placeholder={t("docker.stacks.variableValue")}
                    spellCheck={false}
                    autoComplete="off"
                    className={inputClass}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => toggle(index)}
                    title={t("docker.stacks.reveal")}
                  >
                    {revealed.has(index) ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => update(lines.filter((_, i) => i !== index))}
                    title={t("common.remove")}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ) : line.text.trim().startsWith("#") ? (
                <div
                  key={index}
                  className="truncate px-1 font-mono text-xs text-muted-foreground"
                >
                  {line.text}
                </div>
              ) : null,
            )}
          </div>
        </div>
      )}
    </div>
  );
}
