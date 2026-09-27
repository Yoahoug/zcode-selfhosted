import { memo, useState, type JSX } from "react";
import { Activity, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  useSelfhostResource,
  type SelfhostResourceSnapshot,
} from "@/hooks/useSelfhostResource.js";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "--";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function SelfhostResourceDetails({ snapshot }: { snapshot: SelfhostResourceSnapshot }): JSX.Element {
  const { intl } = useZCodeIntl();
  const rows: Array<[string, string]> = [
    [intl.formatMessage({ id: "selfhost.resource.serverRss" }), formatBytes(snapshot.serverRssBytes)],
    [
      intl.formatMessage({ id: "selfhost.resource.serverHeap" }),
      formatBytes(snapshot.serverHeapUsedBytes),
    ],
    [
      intl.formatMessage({ id: "selfhost.resource.serverUptime" }),
      formatUptime(snapshot.serverUptimeSeconds),
    ],
    [
      intl.formatMessage({ id: "selfhost.resource.wsConnections" }),
      String(snapshot.wsConnectionCount),
    ],
    [
      intl.formatMessage({ id: "selfhost.resource.runningTasks" }),
      String(snapshot.runningTaskCount),
    ],
  ];
  return (
    <dl className="flex flex-col gap-1 px-1 pt-1">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-center justify-between gap-2">
          <dt className="truncate text-ui-xs text-foreground-subtle">{label}</dt>
          <dd className="shrink-0 font-mono text-ui-xs text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 自托管 server 资源小卡片：sidebar footer 左下角的一行摘要，展开后是明细。
 * 默认收起；60s 轮询 `GET /api/selfhost/resource`（同源，服务端鉴权）。
 * 非 web-remote 场景（端点 404/401）静默隐藏，不打扰桌面用户。
 */
export const WorkspaceSidebarFooterSelfhostResource = memo(
  function WorkspaceSidebarFooterSelfhostResourceComponent() {
    const { intl } = useZCodeIntl();
    const [expanded, setExpanded] = useState(false);
    const state = useSelfhostResource(true);

    if (state.status === "idle" || state.status === "error") return null;
    if (state.status === "loading") {
      return (
        <div className="flex items-center gap-1.5 px-1 text-ui-xs text-foreground-subtle">
          <Activity className="size-3.5 animate-pulse" />
          {intl.formatMessage({ id: "selfhost.resource.loading" })}
        </div>
      );
    }

    const snapshot = state.snapshot;
    const busy = snapshot.wsConnectionCount > 0 || snapshot.runningTaskCount > 0;
    const summary = busy
      ? intl.formatMessage({ id: "selfhost.resource.summaryBusy" })
      : snapshot.idleCountdownSeconds === null
        ? intl.formatMessage({ id: "selfhost.resource.summaryIdleOff" })
        : intl.formatMessage(
            { id: "selfhost.resource.summaryIdleIn" },
            { countdown: formatCountdown(snapshot.idleCountdownSeconds) },
          );

    return (
      <div className="rounded-lg border border-border bg-surface">
        <button
          type="button"
          onClick={() => setExpanded((previous) => !previous)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-ui-xs text-foreground-subtle hover:text-foreground"
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              busy ? "bg-success" : "bg-warning",
            )}
          />
          <Activity className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {formatBytes(snapshot.serverRssBytes)} · {summary}
          </span>
          {expanded ? (
            <ChevronUp className="size-3.5 shrink-0" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" />
          )}
        </button>
        {expanded ? (
          <div className="border-t border-border px-2 pt-1 pb-2">
            <SelfhostResourceDetails snapshot={snapshot} />
          </div>
        ) : null}
      </div>
    );
  },
);
