# Selfhost 归档列表数据链路 spec（自托管二开，3.14.3-selfhost.3）

适用形态：`zcode --web` 自托管（`packages/server` 的 `entry-http` + `http.ts`）。
桌面端行为零变化：桌面 Host 的 Controller 聚合面不动，本 spec 只补 server 侧缺失的只读查询能力。

## 现象（已在 ops 复现）

- 服务器 `tasks-index.sqlite` 的 `tasks` 表里 `sess_3a90…` 的 `archived=1`
  （`provider=glm`，`workspace_key=/data/appdata/zcode-web/workspace`），写入路径正常。
- 但 Web 归档视图持续显示"暂无归档任务"（`taskList.noArchivedTasks`），selfhost.2 的
  客户端降级分支没有让它出现。

## 根因（两层）

1. **server 从未注册 `window-controller` 通道**：`windowControllerService` 只在
   `packages/desktop/src/host/index.ts` 注册（聚合多个 source 的投影 + observer 体系），
   `packages/services/src/node.ts` 的 `createLocalServices` 没有它。
   server 的 `ChannelServer` 对未知通道是"挂起等注册、1s 超时后 Unknown channel"，
   不会立即失败。
2. **selfhost.2 的降级开关永远打不开**：Web 的 `RemoteServiceAccess` 在构造时就为
   `windowControllerService` 建好了 `ProxyChannel.toService` 代理对象——禁止用
   `Boolean(baseServices.windowControllerService)` 判断通道是否存在，这个代理对象
   永远 truthy。于是 `hasController` 恒为 true，降级分支恒为 `enabled: false`，
   而 Controller 查询又因第 1 条挂起/超时，归档列表永远是空。

附带：归档视图把未经 `useLocalWorkspaceScopes` 过滤的 `workspaceTabs` 直接传给
`useGlobalTaskList`；pinned/timeline 都是先过滤出本地 tab 再查。单 workspace
自托管下这不是空列表的主因，但与其它视图不一致，整改时一并对齐。

## 整改方案（已决策）：server 侧加轻量只读 Controller，不动桌面

- 新文件 `packages/server/src/selfhostTaskListController.ts`：
  `createSelfhostTaskListController(taskService?)` 返回 `IWindowControllerService`
  的**只读子集实现**，唯一所有者是 server 进程内的这个实例。
  - `listTaskList(query)`：按 `query.workspaceScopes` 逐个调
    `taskService.listArchivedTasks / listPinnedTasks / listTasks`（`archived` 按 kind：
    archived→归档分区；pinned→pinned 且未归档；timeline→未 pinned 未归档；
    active→未归档），拼成 `WindowHostControllerTaskListItem[]`
    （`sourceAvailability: "online"`，`liveStatus` 按 meta 终态映射，
    与桌面 `liveStatusFromMeta` 同口径：completed→completed，error→error，其余 idle），
    按 `sortBy` 排序后按 `limit` 裁剪，返回 `{ items, total, hasMore }`。
    search 非空时走 `taskService.listTaskList`（已带 provider=glm 过滤）再按 kind
    用 `matchesTaskListMembershipKind` 过滤。
  - `deleteArchivedTask / deleteArchivedTasks`：直透到底层 taskService（单条按
    address 组装 workspace 参数；批量按 address 的 workspace 组装 taskIds）。
  - `mutateTask`：归档视图的取消归档/删除按钮走的是 `zcodeTaskService` 直接调用，
    不经过 Controller；此处对 pin/archive/delete/mark 四类做最小直透实现，
    open/resume 为 no-op 返回 null，保持接口完整。
  - `subscribe/resync/unsubscribe + onDynamicControllerFrame`：server 侧无投影，
    订阅返回一次性 ack（`mode: "snapshot"`，进程内唯一 logEpoch），帧流为空事件
    （`Event.None`），客户端 registry 收不到帧就不 bump、不重查——首轮 `list`
    已返回全量，归档/取消归档后 UI 侧已有 `refresh()` + `onDynamicWorkspaceEvent`
    路径驱动重查。
- 接线（`packages/server/src/http.ts`，仅接线）：`setupChannelServer` 内
  `services.getOptional(IZCodeTaskService)` 存在时，
  `overrides.set(IWindowControllerService.channelName, controller)`，
  与现有 `IZCodeAgentService` 的 connectionScope 覆盖写法同构。
  单例 controller 在模块级懒创建（taskService 引用稳定，可复用）。
- UI 回退（`packages/ui`）：删除 `useArchivedTasksFallback.ts`，恢复
  `WorkspaceArchivedTasksFlatSection` 为纯 `useGlobalTaskList(kind: "archived")`，
  并与 pinned/timeline 对齐，用 `useLocalWorkspaceScopes` 过滤后传入。
  `Boolean(windowControllerService)` 代理恒真问题不再存在（server 真有了该通道）。

## 为什么不是其它方案

- 修降级开关（判代理是否存在）：RPC 层没有"通道是否存在"的同步查询口，
  加口等于改协议；且归档/取消归档/删除的 mutation 面仍是双路径，不如 server
  补齐只读 Controller 让 UI 走原路。
- 把桌面 `windowHostControllerRuntime` 搬到 server：聚合面依赖 Host 的
  projection/observer/session overlay 体系，搬运等于在 server 重建半个 Host；
  自托管单 workspace 下直查 tasks-index 已满足归档列表需求。

## 事件顺序与幂等

- 首屏：WebSocket 建连 → 通道已注册（server 启动时即注册，非懒注册，无 pending 超时）→
  Controller.list 逐 workspace 直查 → 首帧即全量。
- 归档/取消归档/删除：按钮直调 `zcodeTaskService`（写 sqlite + 广播
  `workspace_task_list_changed`）→ 视图 `refresh()` 重查 Controller →
  新列表。Controller 本身无状态、无缓存，重复查询结果一致。
- 订阅帧为空：registry 的 `start()` 仍会建订阅，但无帧即无 revision bump；
  `taskListVersion` 变化仍会触发 `load`（`cacheVersionKey` 含其签名）。

## 不变量

- server 的 Controller 永远 `sourceAvailability: "online"`、`liveStatus` 无
  running/waiting（无 session overlay 体系）；自托管只有 server 本地一个 source，
  不处理 remote scope（`resolveQuerySources` 式多源聚合不需要）。
- provider 过滤口径不变：分区读取经 adapter 固定 `provider=glm`；search 路径经
  `listTaskList` 同样带 glm 过滤（见 subagent 结论）。
- 桌面端零变化：只新增 server 文件 + http 接线 + UI 恢复/对齐，
  不碰 `packages/desktop`、`packages/services`。

## 上游同步约束增补（并入 versioning.md）

- 自托管二开收敛位置新增：
  `packages/server/src/selfhostTaskListController.ts`（新建）、
  `packages/server/src/http.ts`（Controller 接线增量）、
  `packages/ui/src/WorkspaceArchivedTasksFlatSection.tsx`（恢复直查+本地 scope 对齐）。
  上游改动 `http.ts` 或归档视图时，同步后重点回归这两处接线。
