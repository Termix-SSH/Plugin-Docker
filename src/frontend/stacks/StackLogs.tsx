import React from "react";
import { Download, Radio, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Button, PanelSearch, cn } from "@termix-ssh/plugin-sdk/ui";
import { getErrorMessage } from "../error-message";
import { useDockerApi } from "../docker-api";

interface StackLogsProps {
  sessionId: string;
  name: string;
  services: string[];
  initialService?: string;
}

const TAILS = [100, 500, 1000, 3000];

export function StackLogs({
  sessionId,
  name,
  services,
  initialService = "",
}: StackLogsProps): React.ReactElement {
  const { t } = useTranslation();
  const docker = useDockerApi();
  const [service, setService] = React.useState(initialService);
  const [tail, setTail] = React.useState(500);
  const [follow, setFollow] = React.useState(true);
  const [search, setSearch] = React.useState("");
  const [logs, setLogs] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const boxRef = React.useRef<HTMLPreElement>(null);
  const stickRef = React.useRef(true);

  React.useEffect(() => setService(initialService), [initialService]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const result = await docker.stackLogs(sessionId, name, {
        service: service || undefined,
        tail,
      });
      setLogs(result.logs);
    } catch (error) {
      toast.error(getErrorMessage(error, t("docker.stacks.logsFailed")));
    } finally {
      setLoading(false);
    }
  }, [docker, sessionId, name, service, tail, t]);

  React.useEffect(() => {
    void load();
    if (!follow) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load, follow]);

  const visible = React.useMemo(() => {
    if (!search) return logs;
    const needle = search.toLowerCase();
    return logs
      .split("\n")
      .filter((line) => line.toLowerCase().includes(needle))
      .join("\n");
  }, [logs, search]);

  React.useEffect(() => {
    const box = boxRef.current;
    if (box && stickRef.current) box.scrollTop = box.scrollHeight;
  }, [visible]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([logs], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}${service ? `-${service}` : ""}.log`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const selectClass =
    "h-8 border border-border bg-background px-2 text-xs focus:outline-none";

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <PanelSearch
          value={search}
          onChange={setSearch}
          placeholder={t("docker.filterLogs")}
        />
        <select
          value={service}
          onChange={(event) => setService(event.target.value)}
          aria-label={t("docker.stacks.service")}
          className={selectClass}
        >
          <option value="">{t("docker.stacks.allServices")}</option>
          {services.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <select
          value={tail}
          onChange={(event) => setTail(Number(event.target.value))}
          aria-label={t("docker.lines")}
          className={selectClass}
        >
          {TAILS.map((value) => (
            <option key={value} value={value}>
              {value} {t("docker.lines")}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setFollow((value) => !value)}
            title={t("docker.stacks.follow")}
            aria-pressed={follow}
            className={cn(follow && "text-accent-brand")}
          >
            <Radio className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void load()}
            title={t("docker.refresh")}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={download}
            title={t("docker.download")}
          >
            <Download className="size-4" />
          </Button>
        </div>
      </div>
      <pre
        ref={boxRef}
        onScroll={(event) => {
          const box = event.currentTarget;
          stickRef.current =
            box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all border border-border bg-background p-2 font-mono text-xs"
      >
        {visible || t("docker.stacks.noLogs")}
      </pre>
    </div>
  );
}
