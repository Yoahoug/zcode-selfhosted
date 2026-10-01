# Selfhost 定时任务（automation）调度器

## 背景与问题（2026-10-01 线上实测）

ZCode 的 cron 调度循环是**桌面端独占**组件：`packages/desktop/src/scheduler/index.ts` 以独立
utility process 运行，只由 Electron main 通过 `spawnCronScheduler`
（`packages/desktop/src/main/desktopCronScheduler.ts`）拉起；认领到期的 automation 后把派发请求交回
main，再由 main 转给某个本地 host 执行 `createTask + sendPrompt`。

自托管 `--web` 形态没有 desktop main，发行包（`scripts/build-zcode.mjs`）也只打包
`web / server / agent / TUI`，不含 desktop 包。服务端 bundle 里只有 `AutomationRepo`
（`claimDue` / `claimManualRuns` 只有定义、没有调用点）与 `computeAutomationNextRunAt`，
于是 automations 只会被创建、`next_run_at` 只会被正确计算，**永远不会被认领和派发**：

- `run_count` 恒为 0、`automation_runs` 无任何行、`claimed_at` 为空、`next_run_at` 停在过去；
- UI「立即运行」不可用：`zcodeAgentService.runAutomationNow` 需要装配层注入
  `onAutomationManualRunRequested`（只有 desktop host 注入），server 侧缺失时直接抛
  `Automation immediate dispatcher is unavailable.`；
- 闲时任务（off-peak）与 automation 共用 desktop scheduler，同样不会派发。

## 方案：调度状态机搬进 server 进程（唯一所有者）

新增 `packages/server/src/selfhostAutomationScheduler.ts`，在 `--web` 入口
（`packages/server/src/entry-http.ts`）装配并 `start()`；`--stdio`（desktop-attached-remote）
不受影响，仍由桌面 main 调度。

调度状态的唯一所有者仍是 `AutomationRepo`（tasks-index.sqlite，WAL 多进程安全），
本类只做「认领 → 派发 → 结算」编排与错误分类，不新增库表、不写第二套状态。

### 行为对齐 desktop scheduler

| 关注点 | 规则 |
| --- | --- |
| 轮询 | 20s（`POLL_INTERVAL_MS`），timer `unref()`，不把 server 钉在事件循环 |
| 认领 | `AutomationRepo.claimDue` / `claimManualRuns`：`BEGIN IMMEDIATE` + `running 0→1` single-flight；僵尸认领按 `CLAIM_STALE_MS`（10 分钟）回收 |
| misfire | 首轮（`dispatchAttempts=0`）且 `next_run_at` 早于 `now - 5min` → `skipAndReschedule` 记 skipped，不补跑 |
| 一次性任务 | `isOneShotAutomation` 且错过窗口 → `finalize`：转 completed、停用、清空 `next_run_at`，不再排后续周期 |
| 成功结算 | `markRunDispatch(dispatched)` + `markDispatched`：`run_count`/`scheduled_run_count` +1、按派发时间重算 `next_run_at`、有限次任务达 `max_runs` 转 completed |
| 失败结算 | 对齐 desktop host：派发异常一律 transient → `markDispatchFailed` 写退避 `retry_at`（30s 起、指数、上限 15 分钟，最多 5 次），达上限后循环任务跳下一个正常触发点 |
| 模型选择 | 派发边界固定：首个 run 解析一次（`getModelSelectionForDispatch` → `getView` 校验 → `fixRunModelSelection`），transient 重试复用同一选择，不因账号变化换模型 |
| 绑定会话 | `targetTaskId` 存在时 `resumeTask` 再 `setAutomationSessionConfig`（模型/思考档位/权限模式），不新建 session；否则 `createTask(automationId)` |
| manual run | 不推进 cron 节奏，只累计 `run_count`；claim 覆盖排队 + 整个 turn，60s 续租（`touchManualClaim`），turn 终态才释放 |
| 终态回写 | `onDynamicTaskTerminalOutcome` 匹配 `inputId === runId` → `markRunOutcome(succeeded/failed/stopped)`，并把 task 置未读 |

### 配置

- `ZCODE_SELFHOST_AUTOMATION_SCHEDULER=0|false` 关闭调度（默认开启），用于线上排障时
  保留 Web UI 与手动任务。关闭时 `onAutomationManualRunRequested` 仍会注入，但会明确报错，
  不会静默吞掉「立即运行」。

## 范围外（保持 desktop-only）

- 闲时任务（off-peak）派发：涉及票务、权限模式切换、会话续跑等独立状态机；
- Bot 回推（`cronBotDelivery`）、`session_create` 遥测、scheduler 资源遥测。

## 验证

- `packages/server/test/selfhostAutomationScheduler.test.ts`：临时库 + 假 task/model 服务，
  覆盖到期派发、misfire 跳过、失败退避、manual 派发与 claim 释放。
- 线上：重启后首次 tick 会把错过的窗口记为 skipped 并把 `next_run_at` 前推到下一个触发点；
  新建一个 2 分钟后的测试 automation，观察 `run_count`、`automation_runs` 与真实 task 创建。
