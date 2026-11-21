import React from "react";
import {
  AlertTriangle,
  Download,
  Eraser,
  FileJson,
  HardDrive,
  Layers,
  Network,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  AddButton,
  Button,
  FormFooter,
  InlineView,
  Input,
  LoadingState,
  NoticePanel,
  PanelSearch,
  PanelShell,
  RefreshButton,
  Segmented,
  StatusBadge,
  ToolbarSelect,
  useAdaptivePolling,
  useConfirm,
} from "@termix-ssh/plugin-sdk/ui";
import { getErrorMessage } from "../error-message";
import { useDockerApi } from "../docker-api";
import type {
  DockerImage,
  DockerNetwork,
  DockerVolume,
  ResourceKind,
} from "../types";

export type ResourceSection = "images" | "volumes" | "networks";

const KIND: Record<ResourceSection, ResourceKind> = {
  images: "image",
  volumes: "volume",
  networks: "network",
};

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:@]{0,254}$/;
const SUBNET_RE = /^[0-9a-fA-F:.]+\/\d{1,3}$/;
const DRIVERS = ["bridge", "overlay", "macvlan", "ipvlan"] as const;

type Row = {
  key: string;
  /** What the remove and inspect actions get. */
  target: string;
  cells: React.ReactNode[];
  search: string;
  inUse: boolean | null;
  removable: boolean;
};

interface ResourcesViewProps {
  sessionId: string;
  section: ResourceSection;
  switcher: React.ReactNode;
}

export function ResourcesView({
  sessionId,
  section,
  switcher,
}: ResourcesViewProps): React.ReactElement {
  const { t } = useTranslation();
  const docker = useDockerApi();
  const confirm = useConfirm();
  const kind = KIND[section];
  const [images, setImages] = React.useState<DockerImage[]>([]);
  const [volumes, setVolumes] = React.useState<DockerVolume[]>([]);
  const [networks, setNetworks] = React.useState<DockerNetwork[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [filter, setFilter] = React.useState("all");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState({
    name: "",
    driver: "bridge",
    subnet: "",
  });
  const [inspecting, setInspecting] = React.useState<{
    name: string;
    data: unknown;
  } | null>(null);
  const signatureRef = React.useRef("");

  React.useEffect(() => {
    setLoaded(false);
    setError(null);
    setFilter("all");
    setSearch("");
    signatureRef.current = "";
  }, [section]);

  const refresh = React.useCallback(async () => {
    try {
      let data: unknown;
      if (section === "images") {
        data = await docker.listImages(sessionId);
        setImages(data as DockerImage[]);
      } else if (section === "volumes") {
        data = await docker.listVolumes(sessionId);
        setVolumes(data as DockerVolume[]);
      } else {
        data = await docker.listNetworks(sessionId);
        setNetworks(data as DockerNetwork[]);
      }
      const signature = JSON.stringify(data);
      const changed = signature !== signatureRef.current;
      signatureRef.current = signature;
      setError(null);
      return changed;
    } catch (err) {
      setError(getErrorMessage(err, t("docker.resources.listFailed")));
      return false;
    } finally {
      setLoaded(true);
    }
  }, [docker, section, sessionId, t]);

  useAdaptivePolling(
    refresh,
    { minIntervalMs: 10000, maxIntervalMs: 60000, stablePollsPerStep: 3 },
    true,
  );

  const rows: Row[] = React.useMemo(() => {
    if (section === "images") {
      return images.map((image) => {
        const named = image.repository && image.repository !== "<none>";
        const label = named
          ? `${image.repository}:${image.tag}`
          : image.id.slice(0, 12);
        return {
          key: image.id + label,
          target:
            named && image.tag !== "<none>" ? label : image.id.slice(0, 12),
          cells: [
            <span className="font-semibold">
              {named ? image.repository : t("docker.resources.untagged")}
            </span>,
            image.tag,
            <span className="font-mono">{image.id.slice(0, 12)}</span>,
            image.size,
            image.created,
          ],
          search: `${image.repository} ${image.tag} ${image.id}`,
          inUse: image.inUse,
          removable: true,
        };
      });
    }
    if (section === "volumes") {
      return volumes.map((volume) => ({
        key: volume.name,
        target: volume.name,
        cells: [
          <span className="font-semibold font-mono">{volume.name}</span>,
          volume.driver,
          <span className="font-mono text-muted-foreground">
            {volume.mountpoint}
          </span>,
        ],
        search: volume.name,
        inUse: volume.inUse,
        removable: true,
      }));
    }
    return networks.map((network) => ({
      key: network.id,
      target: network.name,
      cells: [
        <span className="font-semibold">{network.name}</span>,
        network.driver,
        <span className="font-mono">{network.id.slice(0, 12)}</span>,
      ],
      search: `${network.name} ${network.id}`,
      inUse: null,
      removable: !network.builtIn,
    }));
  }, [images, networks, section, t, volumes]);

  const headers =
    section === "images"
      ? [
          t("docker.resources.repository"),
          t("docker.resources.tag"),
          t("docker.resources.id"),
          t("docker.resources.size"),
          t("docker.resources.created"),
        ]
      : section === "volumes"
        ? [
            t("docker.name"),
            t("docker.resources.driver"),
            t("docker.resources.mountpoint"),
          ]
        : [
            t("docker.name"),
            t("docker.resources.driver"),
            t("docker.resources.id"),
          ];

  const needle = search.trim().toLowerCase();
  const visible = rows.filter((row) => {
    if (needle && !row.search.toLowerCase().includes(needle)) return false;
    if (filter === "used") return row.inUse === true;
    if (filter === "unused") return row.inUse === false;
    return true;
  });

  const runAction = async (
    action: Parameters<typeof docker.resourceAction>[1],
    body: Parameters<typeof docker.resourceAction>[2],
    key: string,
  ): Promise<boolean> => {
    setBusy(key);
    try {
      const result = await docker.resourceAction(sessionId, action, body);
      if (result.message) toast.success(result.message);
      void refresh();
      return true;
    } catch (err) {
      toast.error(getErrorMessage(err, t("docker.resources.actionFailed")));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const remove = (row: Row) => {
    void confirm({
      title: t(`docker.resources.${kind}.confirmRemove`, { name: row.target }),
      confirmLabel: t("common.remove"),
      cancelLabel: t("common.cancel"),
    }).then((ok) => {
      if (!ok) return;
      if (kind === "image") {
        void runAction("remove-image", { image: row.target }, row.key);
      } else if (kind === "volume") {
        void runAction("remove-volume", { name: row.target }, row.key);
      } else {
        void runAction("remove-network", { name: row.target }, row.key);
      }
    });
  };

  const prune = () => {
    void confirm({
      title: t(`docker.resources.${kind}.confirmPrune`),
      confirmLabel: t("docker.resources.prune"),
      cancelLabel: t("common.cancel"),
    }).then((ok) => {
      if (!ok) return;
      if (kind === "image") {
        void runAction("prune-images", { all: true }, "prune");
      } else if (kind === "volume") {
        void runAction("prune-volumes", {}, "prune");
      } else {
        void runAction("prune-networks", {}, "prune");
      }
    });
  };

  const inspect = async (row: Row) => {
    try {
      const data = await docker.inspectResource(sessionId, kind, row.target);
      setInspecting({ name: row.target, data });
    } catch (err) {
      toast.error(getErrorMessage(err, t("docker.resources.inspectFailed")));
    }
  };

  const formValid =
    kind === "image"
      ? IMAGE_RE.test(form.name)
      : NAME_RE.test(form.name) &&
        (kind !== "network" || !form.subnet || SUBNET_RE.test(form.subnet));

  const create = async () => {
    setSaving(true);
    const ok =
      kind === "image"
        ? await runAction("pull-image", { image: form.name.trim() }, "create")
        : kind === "volume"
          ? await runAction("create-volume", { name: form.name }, "create")
          : await runAction(
              "create-network",
              {
                name: form.name,
                driver: form.driver,
                subnet: form.subnet.trim() || undefined,
              },
              "create",
            );
    setSaving(false);
    if (ok) {
      setCreating(false);
      setForm({ name: "", driver: "bridge", subnet: "" });
    }
  };

  const Icon =
    section === "images" ? Layers : section === "volumes" ? HardDrive : Network;

  return (
    <>
      <PanelShell
        icon={<Icon className="size-4" />}
        title={t(`docker.resources.${kind}.title`)}
        status={
          loaded
            ? t(`docker.resources.${kind}.count`, { count: rows.length })
            : undefined
        }
        actions={
          <RefreshButton
            onClick={() => void refresh()}
            loading={!loaded}
            label={t("docker.refresh")}
          />
        }
        toolbar={
          <>
            {switcher}
            <PanelSearch
              value={search}
              onChange={setSearch}
              placeholder={t("docker.resources.search")}
            />
            <AddButton
              label={t(`docker.resources.${kind}.add`)}
              onClick={() => setCreating(true)}
            />
            {kind !== "network" && (
              <Segmented
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: t("docker.resources.all") },
                  { value: "used", label: t("docker.resources.inUse") },
                  { value: "unused", label: t("docker.resources.unused") },
                ]}
              />
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={prune}
              disabled={busy === "prune"}
              className="ml-auto text-xs"
            >
              <Eraser className="size-3.5" />
              {t("docker.resources.prune")}
            </Button>
          </>
        }
      >
        {!loaded ? (
          <LoadingState label={t("docker.resources.loading")} />
        ) : error ? (
          <NoticePanel
            tone="destructive"
            icon={AlertTriangle}
            title={t("docker.error")}
          >
            {error}
          </NoticePanel>
        ) : visible.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {rows.length === 0
              ? t(`docker.resources.${kind}.empty`)
              : t("docker.resources.noMatches")}
          </p>
        ) : (
          <div className="overflow-auto">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-background">
                <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                  {headers.map((header) => (
                    <th
                      key={header}
                      className="px-3 py-2 text-left font-semibold"
                    >
                      {header}
                    </th>
                  ))}
                  {kind !== "network" && (
                    <th className="px-3 py-2 text-left font-semibold">
                      {t("docker.resources.usage")}
                    </th>
                  )}
                  <th className="px-3 py-2 text-right font-semibold">
                    {t("docker.actions")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border border-b border-border">
                {visible.map((row) => (
                  <tr key={row.key} className="hover:bg-muted/40">
                    {row.cells.map((cell, index) => (
                      <td
                        key={index}
                        className="max-w-[24rem] truncate px-3 py-2"
                      >
                        {cell}
                      </td>
                    ))}
                    {row.inUse !== null && (
                      <td className="px-3 py-2">
                        <StatusBadge tone={row.inUse ? "ok" : "idle"}>
                          {row.inUse
                            ? t("docker.resources.inUse")
                            : t("docker.resources.unused")}
                        </StatusBadge>
                      </td>
                    )}
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("docker.resources.inspect")}
                          onClick={() => void inspect(row)}
                        >
                          <FileJson className="size-3.5" />
                        </Button>
                        {row.removable && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t("common.remove")}
                            disabled={busy === row.key}
                            onClick={() => remove(row)}
                            className="text-destructive"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PanelShell>
      <InlineView
        open={creating}
        onOpenChange={setCreating}
        title={t(`docker.resources.${kind}.add`)}
        icon={
          kind === "image" ? (
            <Download className="size-4" />
          ) : (
            <Icon className="size-4" />
          )
        }
        footer={
          <FormFooter
            onCancel={() => setCreating(false)}
            onSave={() => void create()}
            saveLabel={t(`docker.resources.${kind}.save`)}
            cancelLabel={t("common.cancel")}
            saving={saving}
            disabled={!formValid}
          />
        }
      >
        <div className="flex flex-col gap-3 p-3">
          <label className="flex flex-col gap-1 text-xs font-semibold">
            {kind === "image"
              ? t("docker.resources.image.ref")
              : t("docker.name")}
            <Input
              value={form.name}
              onChange={(event) =>
                setForm((current) => ({ ...current, name: event.target.value }))
              }
              placeholder={kind === "image" ? "nginx:latest" : "my-data"}
              spellCheck={false}
              className="font-mono font-normal"
            />
            {kind === "image" && (
              <span className="font-normal text-muted-foreground">
                {t("docker.resources.image.refHint")}
              </span>
            )}
          </label>
          {kind === "network" && (
            <>
              <div className="flex flex-col gap-1 text-xs font-semibold">
                {t("docker.resources.driver")}
                <ToolbarSelect
                  value={form.driver}
                  onChange={(driver) =>
                    setForm((current) => ({ ...current, driver }))
                  }
                  label={t("docker.resources.driver")}
                  options={DRIVERS.map((driver) => ({
                    value: driver,
                    label: driver,
                  }))}
                />
              </div>
              <label className="flex flex-col gap-1 text-xs font-semibold">
                {t("docker.resources.network.subnet")}
                <Input
                  value={form.subnet}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      subnet: event.target.value,
                    }))
                  }
                  placeholder="10.20.0.0/24"
                  spellCheck={false}
                  className="font-mono font-normal"
                />
              </label>
            </>
          )}
        </div>
      </InlineView>
      <InlineView
        open={inspecting !== null}
        onOpenChange={(open) => {
          if (!open) setInspecting(null);
        }}
        title={inspecting?.name ?? ""}
        icon={<FileJson className="size-4" />}
      >
        <pre className="overflow-auto p-3 font-mono text-xs">
          {inspecting ? JSON.stringify(inspecting.data, null, 2) : ""}
        </pre>
      </InlineView>
    </>
  );
}
