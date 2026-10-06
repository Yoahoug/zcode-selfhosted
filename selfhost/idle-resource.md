# Selfhost 空闲资源管理 spec（自托管二开）

适用形态：`zcode --web` 自托管（`packages/server` 的 `entry-http` + `http.ts`）。
不改动协议、不新增 RPC 通道、不动 Agent runtime 内部状态机。

## 行为

1. **空闲判定**：WS 连接数为 0 且 Agent 无活跃任务（`runningTaskCount === 0`）持续
   `ZCODE_SELFHOST_IDLE_TIMEOUT_MINUTES`（默认 30，`0` 表示关闭）分钟后，进入空闲态。
2. **空闲释放**：进入空闲态时
   - 對仍存活的 workspace 调用 `disposeWorkspace`（复用现有接口，杀 Agent 进程树），
     但不 touch 会话落库数据；下一次请求按现有 single-flight 正常重建。
   - server 进程自身保留（保活与秒开），只释放 Agent 子进程内存。
3. **观测**：`GET /api/selfhost/resource`（token 中间件之后注册，自动受鉴权保护）返回
   server 进程 `process.memoryUsage()` 快照 + WS 连接数 + agent 活跃任务数 + 空闲剩余秒数。
   采样是请求时同步读取，无后台定时器。
4. **前端**：`WorkspaceSidebarFooter` 内嵌一个可折叠小卡片，60s 轮询上述端点一次
   （页面不可见时暂停），展示 server RSS / WS 连接数 / 活跃任务 / 空闲倒计时。

## 所有者与事件顺序

- 唯一所有者：server 进程内的 `SelfhostIdleResourceManager`（`packages/server/src/` 新文件）。
  任务计数来源是 `task-activity` 风格的订阅：复用 `onDynamicConversationTelemetryFact`
  还是 daemon 侧的 taskActivityTracker 语义由实现时二选一，但只允许一处计数真相。
- 事件顺序：WS open/close 更新连接数 → telemetry fact 更新任务数 → 计时器到期 →
  disposeWorkspace → 卡片下一次轮询看到数值变化。
- 幂等：空闲计时器每次只调度一个；dispose 失败只记日志，不重试、不崩进程。

## 不变量与失败语义

- `disposeWorkspace` 只杀进程、不删会话数据；失败时保持计时器关闭，等待下一次活跃后再重新计时。
- 资源端点只返回本机聚合数值，不返回 pid、路径、token。
- WebSocket 客户端计数只统计 `/ws`（terminal-client），`/ws/host` 可信通道不计入
  （桌面 Dev 联调不应阻止服务器空闲释放）。

## 迁移边界

- 环境变量全部可选，不设置时行为与上游一致（空闲释放默认开启 30 分钟，可设 `0` 关闭）。
- 前端卡片默认收起为一行，不挤占 footer 现有布局；桌面端同样可用。

## 释放前台账二次确认（3.14.3-selfhost.2）

内存计数器的已知盲区：turn 计数只认「已经开始的 turn」。定时任务（automation）与
闲时任务（off-peak）从派发到 Agent turn 真正开始之间有数秒到数十秒（Agent 冷启动更久）
没有 turn 事件；页面关闭后 WS 计数为 0，若空闲阈值恰好落在这个窗口，会把刚拉起的
Agent 杀掉，任务当场中断且无任何恢复。

修复口径：

1. `SelfhostIdleResourceManager` 增加可选的 `SelfhostTaskActivitySource`（任务台账快照），
   释放前对每个 workspace 查询 `listTasks` 聚合出两个信号：
   - `runningTaskCount`：`status === "running"`（缺省视为 running，与 `taskStatus` 口径一致）
     或存在 `pendingInteraction`（阻塞在权限确认/提问上的任务同样没结束）的任务数。
   - `lastTaskActivityAt`：所有任务 `updatedAt` 的最大值；无任务为 `null`。
2. 判定：任一任务 running/阻塞 → 活跃；无活跃任务但 `lastTaskActivityAt` 距今
   不足 3 分钟（`TASK_ACTIVITY_GRACE_MS`）→ 仍视为活跃（覆盖冷启动窗口与台账落盘尾巴）。
3. 失败语义：台账读取抛错时按「活跃」处理——宁可多占一会儿内存，也不杀正在跑的任务。
4. 台账快照不新增持久化、不新增 RPC 通道，真相源仍是 tasks-index.sqlite；
   空闲管理器内的计数器与台账查询不互写，内存计数仍是唯一实时计数所有者，
   台账只作为释放闸门的慢路径二次确认。
5. `listTasks` 按请求的 `workspacePath` + `workspaceIdentity` 过滤，与任务列表
   （task-list-controller）的隔离口径一致，不做全局查询。

事件顺序（同一 workspace）：

```
定时任务派发（automation scheduler）
  → task meta 创建/updatedAt 更新（tasks-index）
  → Agent 冷启动（无 turn 事件窗口）
  → [若空闲计时器此刻到期] 释放循环 → 台账查询 → lastTaskActivityAt < 3min → 不释放，重置计时
  → turn 开始（内存计数器 +1，回到原有判定路径）

释放循环本身：releasing 标志防重入；同轮空闲内每个 workspace 至多 dispose 一次；
  存在任一活跃 workspace 时不锁死 releasedWhileIdle，重置 idleSince 下一轮重评。
```

## 实测行为补充（3.14.3-selfhost.1 部署后验证）

- 空闲释放的作用对象是「Agent runtime 进程树」：server 从不主动拉起 Agent，只有浏览器
  打开工作区、触发会话请求后才会 spawn。因此从未有浏览器访问过的服务器上，
  `workspaceTargets` 恒为空，空闲释放自然为 no-op，进程树只有 server 自身。
- 这意味着稳态内存就是 server 进程的 RSS（约 180-190MB）；Agent 子进程（通常再 +100-200MB）
  只在用户实际使用会话后出现，并在空闲阈值后由 disposeWorkspace 回收。
- `idleCountdownSeconds` 从最后一个活动归零开始倒数；释放完成后变 `null`（releasedWhileIdle），
  下一次 WS 连接或 turn 事件重置。
