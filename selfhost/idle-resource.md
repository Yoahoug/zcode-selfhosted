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
