import { randomUUID } from "node:crypto";
import { Event } from "@zcode/rpc";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  IWindowControllerService,
  IZCodeTaskService,
  WindowHostControllerFrame,
  WindowHostControllerMutation,
  WindowHostControllerTaskListItem,
  ZCodeArchivedTaskDeletionResult,
  ZCodeTaskListQuery,
} from "@zcode/services";
import type {
  ControllerResyncParams,
  ControllerResyncResult,
  ControllerSubscribeParams,
  ControllerSubscribeResult,
  ControllerUnsubscribeParams,
  WindowHostTaskAddress,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 自托管 `--web` 的轻量 WindowController：只读聚合，无投影、无订阅帧。
 *
 * 为什么 server 需要它：归档 / pinned / timeline 等侧栏列表统一走
 * `windowControllerService.listTaskList`（`useGlobalTaskList`）。该通道只在桌面
 * Host 注册（`packages/desktop/src/host/index.ts`），server 的 `--web` 形态没有，
 * ChannelServer 对未知通道挂起等待（1s 超时 Unknown channel），归档视图因此永远是空。
 *
 * 为什么是只读直查而不是搬桌面 runtime：桌面聚合面依赖 Host 的
 * projection / observer / session-overlay 体系；自托管只有一个本地 source，
 * 归档列表只需按 kind 直查 tasks-index 分区（provider=glm 口径由 adapter 保证）。
 * 无状态、无缓存、无后台订阅，因此也没有桌面侧的 stale / single-flight 问题。
 * 归属判定不读 meta 字段（`ZCodeTaskMeta` 不带 pinned/archived，归属只存在于
 * sqlite 行列）：与桌面 `readSourceTaskIndex` 同口径，按分区来源决定 kind
 * （archived 分区→archived；pinned 分区→pinned；listTasks 分区→timeline；
 * active = 后两者合并）。
 *
 * 事件顺序：WebSocket 建连时通道已注册（http.ts 接线）→ 首轮 list 即全量 →
 * 归档/取消归档/删除走 zcodeTaskService 直接写 sqlite 并广播
 * `workspace_task_list_changed` → 视图 refresh() 重查。订阅帧恒为空，
 * registry 收不到帧就不 bump，taskListVersion 变化仍会触发重查。
 */
export function createSelfhostTaskListController(
  taskService: IZCodeTaskService | undefined,
): IWindowControllerService {
  const logEpoch = randomUUID();

  function liveStatusFromMeta(meta: ZCodeTaskMeta): WindowHostControllerTaskListItem["liveStatus"] {
    // 与桌面 Host 的 liveStatusFromMeta 同口径：tasks-index 的 status 只有
    // completed / error 两种终态映射，其余一律 idle（server 无 session overlay，
    // 永远没有 running / waiting）。
    if (meta.status === "completed") return "completed";
    if (meta.status === "error") return "error";
    return "idle";
  }

  function toItem(meta: ZCodeTaskMeta): WindowHostControllerTaskListItem {
    return {
      ...meta,
      sourceAvailability: "online",
      liveStatus: liveStatusFromMeta(meta),
    };
  }

  function compareItems(
    left: WindowHostControllerTaskListItem,
    right: WindowHostControllerTaskListItem,
    sortBy: ZCodeTaskListQuery["sortBy"],
  ): number {
    const leftAt = sortBy === "created" ? left.createdAt : left.updatedAt;
    const rightAt = sortBy === "created" ? right.createdAt : right.updatedAt;
    return rightAt - leftAt || left.taskId.localeCompare(right.taskId);
  }

  function addressParams(address: WindowHostTaskAddress): {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  } {
    return {
      taskId: address.taskId,
      workspacePath: address.workspacePath,
      ...(address.workspaceIdentity ? { workspaceIdentity: address.workspaceIdentity } : {}),
    };
  }

  function scopeParams(scope: { workspacePath: string; workspaceIdentity?: string }): {
    workspacePath: string;
    workspaceIdentity?: string;
  } {
    return {
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    };
  }

  async function listTaskList(
    query: ZCodeTaskListQuery,
  ): Promise<{ items: WindowHostControllerTaskListItem[]; total: number; hasMore: boolean }> {
    if (!taskService || query.workspaceScopes.length === 0) {
      return { items: [], total: 0, hasMore: false };
    }
    const search = query.search?.trim();
    if (search) {
      // 全文搜索走 sqlite 的 queryTaskList（title / searchable_text），kind 过滤
      // 已在 SQL 层按分区完成（与桌面 search 路径同口径），这里只做跨 scope 合并。
      const perScope = await Promise.all(
        query.workspaceScopes.map(async (scope) => {
          try {
            const result = await taskService.listTaskList({
              ...query,
              workspaceScopes: [scopeParams(scope)],
              limit: undefined,
            });
            return result.items;
          } catch {
            // 单个 workspace 搜索失败不能清空其他 workspace 的结果。
            return [];
          }
        }),
      );
      const items = perScope.flat().map(toItem);
      items.sort((left, right) => compareItems(left, right, query.sortBy));
      const total = items.length;
      const visible = query.limit == null ? items : items.slice(0, query.limit);
      return { items: visible, total, hasMore: total > visible.length };
    }
    const perScope = await Promise.all(
      query.workspaceScopes.map(async (scope) => {
        // 分区读取经 adapter 固定 provider=glm；active 是"未归档"（含 pinned），
        // timeline 是"未 pinned 未归档"，与 matchesTaskListMembershipKind 同口径。
        const request = scopeParams(scope);
        try {
          switch (query.kind) {
            case "archived":
              return (await taskService.listArchivedTasks(request)).map(toItem);
            case "pinned":
              return (await taskService.listPinnedTasks(request)).map(toItem);
            case "active": {
              const [plain, pinned] = await Promise.all([
                taskService.listTasks(request),
                taskService.listPinnedTasks(request),
              ]);
              return [...plain, ...pinned].map(toItem);
            }
            default:
              return (await taskService.listTasks(request)).map(toItem);
          }
        } catch {
          // 一个 workspace 读取失败不能清空其他 workspace 的可信列表。
          return [];
        }
      }),
    );
    const items = perScope.flat();
    items.sort((left, right) => compareItems(left, right, query.sortBy));
    const total = items.length;
    const visible = query.limit == null ? items : items.slice(0, query.limit);
    return { items: visible, total, hasMore: total > visible.length };
  }

  async function subscribeControllerV4(
    params: ControllerSubscribeParams,
  ): Promise<ControllerSubscribeResult> {
    // server 无投影：订阅只返回一次性 ack（snapshot 模式 + 进程内唯一 logEpoch），
    // 之后帧流恒为空。客户端 registry 建订阅后收不到帧即不 bump、不重查；
    // 首轮 list 已返回全量，mutation 后由 UI refresh + workspace 事件驱动重查。
    void params;
    return {
      ack: {
        subscriptionId: randomUUID(),
        mode: "snapshot",
        logEpoch,
      },
    };
  }

  async function resyncControllerV4(
    params: ControllerResyncParams,
  ): Promise<ControllerResyncResult> {
    void params;
    return {
      ack: {
        subscriptionId: randomUUID(),
        mode: "snapshot",
        logEpoch,
      },
    };
  }

  async function unsubscribeControllerV4(params: ControllerUnsubscribeParams): Promise<void> {
    void params;
    return undefined;
  }

  return {
    listTaskList,
    async deleteArchivedTask(params: { address: WindowHostTaskAddress }): Promise<boolean> {
      if (!taskService) return false;
      return taskService.deleteArchivedTask(addressParams(params.address));
    },
    async deleteArchivedTasks(params: {
      address: WindowHostTaskAddress;
      taskIds: string[];
    }): Promise<ZCodeArchivedTaskDeletionResult> {
      if (!taskService || params.taskIds.length === 0) {
        return { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] };
      }
      return taskService.deleteArchivedTasks({
        ...scopeParams(params.address),
        taskIds: params.taskIds,
      });
    },
    async mutateTask(params: {
      address: WindowHostTaskAddress;
      mutation: WindowHostControllerMutation;
    }): Promise<ZCodeTaskMeta | null> {
      if (!taskService) return null;
      // 归档视图的取消归档/删除按钮走 zcodeTaskService 直接调用，不经过 Controller；
      // 这里只为其它经 Controller 路由的调用方提供最小直透实现。
      const base = addressParams(params.address);
      switch (params.mutation.kind) {
        case "pin":
          return taskService.setTaskPinned({ ...base, pinned: params.mutation.pinned });
        case "archive":
          return params.mutation.archived
            ? taskService.archiveTask(base)
            : taskService.unarchiveTask(base);
        case "delete":
          await taskService.deleteTask(base);
          return null;
        case "delete-archived":
          await taskService.deleteArchivedTask(base);
          return null;
        case "mark-read":
          return taskService.setTaskUnread({
            ...base,
            unread: false,
            ...(params.mutation.expectedUnreadAt != null
              ? { expectedUnreadAt: params.mutation.expectedUnreadAt }
              : {}),
          });
        case "mark-unread":
          return taskService.setTaskUnread({ ...base, unread: true });
        case "open":
        case "resume":
          return null;
        default: {
          const exhaustive: never = params.mutation;
          throw new Error(`未知 Controller mutation: ${String(exhaustive)}`);
        }
      }
    },
    subscribeControllerV4,
    resyncControllerV4,
    unsubscribeControllerV4,
    onDynamicControllerFrame(): Event<WindowHostControllerFrame> {
      // 无投影即无帧：返回空事件，registry 不会因此 bump 或重查。
      return Event.None;
    },
  };
}
