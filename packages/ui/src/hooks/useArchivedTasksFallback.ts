import { useCallback, useEffect, useRef, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { WindowHostControllerTaskListItem } from "@zcode/services";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

/**
 * 归档列表的 Controller 缺失降级：直接读各 workspace 的 `zcodeTaskService.listArchivedTasks`。
 *
 * 背景：`useGlobalTaskList(kind: "archived")` 依赖 `windowControllerService`，
 * 该服务只在桌面 Host 注册（`packages/desktop/src/host/index.ts`），`packages/server`
 * 的 `--web` 自托管形态没有它。降级只在 Controller 不可用时生效，桌面端走原路，
 * 因此桌面行为零变化。
 *
 * 为什么不把 windowHostControllerService 搬到 server：聚合面依赖桌面 Host 的
 * projection/observer 体系，搬运等于在 server 里重建半个 Host；归档列表只是只读
 * 展示，直查 tasks-index 即可满足。
 */
export interface ArchivedTasksFallbackResult {
  items: WindowHostControllerTaskListItem[];
  total: number;
  loading: boolean;
  refresh: () => void;
}

function liveStatusFromMeta(meta: ZCodeTaskMeta): WindowHostControllerTaskListItem["liveStatus"] {
  // 与桌面 Host 的 liveStatusFromMeta 同口径（windowHostControllerService.ts）：
  // tasks-index 的 status 只有 completed/error 两种终态映射，其余一律 idle。
  if (meta.status === "completed") return "completed";
  if (meta.status === "error") return "error";
  return "idle";
}

export function useArchivedTasksFallback(params: {
  enabled: boolean;
  workspaceTabs: WorkspaceTabState[];
  sortBy: "created" | "updated";
}): ArchivedTasksFallbackResult {
  const baseServices = useBaseWorkspaceServices();
  const [items, setItems] = useState<WindowHostControllerTaskListItem[]>([]);
  const [loading, setLoading] = useState(params.enabled);
  const [refreshSerial, setRefreshSerial] = useState(0);
  const requestSerialRef = useRef(0);

  const refresh = useCallback(() => {
    setRefreshSerial((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!params.enabled) {
      setItems([]);
      setLoading(false);
      return;
    }
    // Controller 缺失时才降级：桌面端 baseServices 一定有 Controller，enabled 为 false。
    if (baseServices.windowControllerService) {
      setItems([]);
      setLoading(false);
      return;
    }
    const requestSerial = ++requestSerialRef.current;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const perWorkspace = await Promise.all(
          params.workspaceTabs.map(async (tab) => {
            try {
              const tasks = await baseServices.zcodeTaskService.listArchivedTasks({
                workspacePath: tab.workspacePath,
                ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
              });
              return tasks.map(
                (meta): WindowHostControllerTaskListItem => ({
                  ...meta,
                  sourceAvailability: "online" as const,
                  liveStatus: liveStatusFromMeta(meta),
                }),
              );
            } catch (error) {
              // 单个 workspace 读取失败不能清空其他 workspace 的归档。
              logger.error("[useArchivedTasksFallback] 读取归档任务失败:", error, {
                workspacePath: tab.workspacePath,
              });
              return [];
            }
          }),
        );
        if (cancelled || requestSerialRef.current !== requestSerial) return;
        const merged = perWorkspace.flat();
        merged.sort((left, right) =>
          params.sortBy === "created"
            ? right.createdAt - left.createdAt
            : right.updatedAt - left.updatedAt,
        );
        setItems(merged);
      } catch (error) {
        if (!cancelled) {
          logger.error("[useArchivedTasksFallback] 归档降级查询失败:", error);
          setItems([]);
        }
      } finally {
        if (!cancelled && requestSerialRef.current === requestSerial) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseServices, params.enabled, params.sortBy, params.workspaceTabs, refreshSerial]);

  return { items, total: items.length, loading, refresh };
}
