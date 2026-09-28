import type { ZCodeWorkspaceEvent } from "@zcode/shared";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { shouldRefetchTaskListMembershipForWorkspaceEvent } from "@/lib/taskListRefreshPolicy.js";

/**
 * 全局视图（timeline / pinned / archived）走 Controller 查询缓存，
 * 失效只认 controllerRevision（帧）/ taskListVersion / manualRefreshSerial。
 * 自托管 server 侧轻量 Controller 恒不发帧，mutation 后必须由
 * `workspace_task_list_changed` 事件驱动 refresh（见 selfhost/task-list-controller.md）。
 * 过滤口径与 useWorkspaceTaskLists 保持一致，不另造词表。
 */
export function shouldRefreshGlobalTaskListOnWorkspaceEvent(
  event: ZCodeWorkspaceEvent,
  scope: { workspacePath: string; workspaceIdentity?: string },
): boolean {
  if (event.type !== "workspace_task_list_changed") {
    return false;
  }
  const eventWorkspaceKey = buildTaskWorkspaceKey(event.workspacePath, event.workspaceIdentity);
  if (eventWorkspaceKey !== buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity)) {
    return false;
  }
  return shouldRefetchTaskListMembershipForWorkspaceEvent(event);
}

export interface CoalescedRefreshScheduler {
  schedule(): void;
  /** 组件卸载时调用：丢弃已排程但未触发的重查，避免卸载后 setState。 */
  dispose(): void;
}

/** 同一窗口内的连续事件（批量删除、自动归档逐条 emit）合并为一次重查。 */
export function createCoalescedRefreshScheduler(
  refresh: () => void,
  windowMs = 50,
): CoalescedRefreshScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule() {
      if (timer !== null) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, windowMs);
    },
    dispose() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
