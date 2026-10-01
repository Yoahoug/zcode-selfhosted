import {
  AutomationRepo,
  computeAutomationNextRunAt,
  isOneShotAutomation,
} from "@zcode/services/node";
import type { IModelSelectionService, IZCodeTaskService } from "@zcode/services";
import {
  formatLogPrefix,
  resolveWorkspaceKey,
  type ZCodeAutomation,
  type ZCodeAutomationRunOutcome,
  type ZCodeAutomationTrigger,
} from "@zcode/shared";
import type { IDisposable } from "@zcode/rpc";
import { dispatchAutomationRun } from "./selfhostAutomationDispatch.js";

/**
 * 自托管 `--web` 的定时任务（automation）调度器：唯一所有者。
 *
 * 背景：上游的 cron 调度循环是桌面端组件（`packages/desktop/src/scheduler`），
 * 只由 Electron main 通过 `spawnCronScheduler` 拉起。`--web` 形态没有 desktop main，
 * 发行包也不包含 desktop 包，于是 `automations` 只会被创建、`next_run_at` 只会被计算，
 * 永远不会被认领和派发——`run_count` 停在 0、`automation_runs` 无行、UI「立即运行」
 * 也会因为缺 `onAutomationManualRunRequested` 注入而直接报错。
 *
 * 本类把 desktop scheduler 的「轮询认领 → 派发 → 结算」状态机搬进 server 进程内，
 * 行为逐项对齐（20s 轮询、misfire 跳过、一次性任务错过即终态、transient 退避重试最多
 * DISPATCH_MAX_ATTEMPTS 次后跳下一个正常触发点）。调度状态仍全部由 AutomationRepo 独占，
 * 本类只做编排与派发，不写库表。
 *
 * 范围：cron automation 的定时触发与「立即运行」。闲时任务（off-peak）、Bot 回推、
 * session_create 遥测不在本次范围内，保持 desktop-only。
 */

/** 轮询间隔：cron 最小粒度是分钟，20s 足以按时命中且开销低（与 desktop scheduler 一致）。 */
const POLL_INTERVAL_MS = 20_000;
/**
 * misfire 宽限：next_run_at 早于 now 超过该值，视为「服务未运行期间错过的窗口」→ 记 skipped 不补跑。
 * 取值需明显大于一次正常轮询延迟，又能覆盖短暂卡顿。
 */
const MISFIRE_GRACE_MS = 5 * 60_000;
/**
 * manual run 续租间隔：claim 覆盖排队 + 整个 turn 执行，超过 CLAIM_STALE_MS（10 分钟）
 * 不续租会被当作僵尸回收并重复派发。
 */
const MANUAL_CLAIM_HEARTBEAT_MS = 60_000;
/** 服务重启后上一进程残留的认领会在 claimDue/claimManualRuns 内按 CLAIM_STALE 回收，无需启动期清理。 */

const LOG_PREFIX = "zcode-server:selfhost-automation";

function log(message: string): void {
  console.log(formatLogPrefix(LOG_PREFIX, process.pid), message);
}

function logWarn(message: string, error?: unknown): void {
  console.warn(formatLogPrefix(LOG_PREFIX, process.pid), message, error ?? "");
}

interface InFlightRun {
  automationId: string;
  workspaceKey: string;
  trigger: ZCodeAutomationTrigger;
}

interface RunWatch {
  taskId: string;
  runId: string;
  disposed: boolean;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  subscription: IDisposable | undefined;
}

interface TerminalOutcomeParams {
  automation: ZCodeAutomation;
  taskId: string;
  runId: string;
  scheduledAt: number | null;
  trigger: ZCodeAutomationTrigger;
  outcome: ZCodeAutomationRunOutcome;
  error?: string;
}

/** 自托管定时任务调度开关：`ZCODE_SELFHOST_AUTOMATION_SCHEDULER=0/false` 关闭（默认开启）。 */
export function resolveSelfhostAutomationSchedulerEnabled(env: NodeJS.ProcessEnv): boolean {
  const raw = env["ZCODE_SELFHOST_AUTOMATION_SCHEDULER"]?.trim();
  if (!raw) return true;
  return raw !== "0" && raw.toLowerCase() !== "false";
}

export interface SelfhostAutomationSchedulerOptions {
  taskService?: IZCodeTaskService;
  modelSelectionService?: IModelSelectionService;
  /** 测试注入的 tasks-index 库路径；生产不传，走默认数据目录。 */
  dbPath?: string;
  /** 测试注入：轮询节拍；生产固定 20s。 */
  pollIntervalMs?: number;
  /** 测试注入：misfire 宽限；生产固定 5 分钟。 */
  misfireGraceMs?: number;
  /** 测试注入：manual claim 续租间隔。 */
  manualClaimHeartbeatMs?: number;
}

export class SelfhostAutomationScheduler {
  private readonly repo: AutomationRepo;
  private readonly taskService: IZCodeTaskService | undefined;
  private readonly modelSelectionService: IModelSelectionService | undefined;
  private readonly pollIntervalMs: number;
  private readonly misfireGraceMs: number;
  private readonly manualClaimHeartbeatMs: number;
  private readonly inFlight = new Map<string, InFlightRun>();
  private readonly runWatches = new Map<string, RunWatch>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;
  private disposed = false;

  constructor(options: SelfhostAutomationSchedulerOptions = {}) {
    this.repo = new AutomationRepo(options.dbPath);
    this.taskService = options.taskService;
    this.modelSelectionService = options.modelSelectionService;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.misfireGraceMs = options.misfireGraceMs ?? MISFIRE_GRACE_MS;
    this.manualClaimHeartbeatMs = options.manualClaimHeartbeatMs ?? MANUAL_CLAIM_HEARTBEAT_MS;
  }

  start(): void {
    if (this.disposed || this.timer) return;
    if (!this.taskService) {
      logWarn("task service unavailable; automation dispatch is disabled");
      return;
    }
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    // 调度器不能把 server 进程钉在事件循环里；HTTP 监听本身已保持进程存活。
    this.timer.unref?.();
    log(`started pollIntervalMs=${this.pollIntervalMs}`);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const watch of this.runWatches.values()) this.disposeRunWatch(watch);
    this.runWatches.clear();
    // 释放本进程仍在途的认领，避免下次启动等到 CLAIM_STALE 才回收。
    for (const [runId, context] of this.inFlight) {
      try {
        if (context.trigger === "manual") {
          await this.repo.releaseManualClaim(context.automationId, context.workspaceKey);
        } else {
          await this.repo.releaseClaim(context.automationId);
        }
      } catch {
        // 退出路径尽力而为。
      }
      this.inFlight.delete(runId);
    }
    try {
      this.repo.close();
    } catch {
      // 忽略：退出路径尽力而为。
    }
  }

  /** 单步调度：认领到期 automation 与 manual run 并逐个派发。测试直接驱动本方法。 */
  async tick(): Promise<void> {
    if (this.disposed || this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      for (const automation of await this.repo.claimDue(now)) {
        await this.handleClaimed(automation, now);
      }
      for (const claimed of await this.repo.claimManualRuns(now)) {
        await this.dispatchAndSettle(claimed.automation, claimed.run.runId, "manual");
      }
    } catch (error) {
      logWarn("tick failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.ticking = false;
    }
  }

  /** UI「立即运行」的派发入口（经 zcodeAgentService.runAutomationNow 注入调用）。 */
  async dispatchManualRun(params: {
    automation: ZCodeAutomation;
    run: { runId: string };
  }): Promise<void> {
    await this.dispatchAndSettle(params.automation, params.run.runId, "manual");
  }

  private async handleClaimed(automation: ZCodeAutomation, now: number): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(automation);
    const scheduledAt = automation.nextRunAt ?? automation.retryAt ?? now;
    const runId = `${automation.automationId}:${scheduledAt}`;
    const isRetry = automation.dispatchAttempts > 0;
    // misfire：首轮（非重试）且计划时刻已远早于 now → 服务未运行期间错过的窗口，记 skipped 不补跑。
    const missed =
      !isRetry && automation.nextRunAt != null && automation.nextRunAt <= now - this.misfireGraceMs;
    if (missed) {
      // 一次性任务的目标时刻是确定承诺，错过即终态；循环任务前推到下一个未来触发点。
      const finalize = isOneShotAutomation(automation);
      await this.repo.skipAndReschedule({
        automationId: automation.automationId,
        runId,
        workspaceKey,
        scheduledAt,
        reason: "server_not_running",
        nextRunAt: finalize ? null : computeAutomationNextRunAt(automation, now),
        finalize,
      });
      log(
        `skip missed window automation=${automation.automationId} scheduledAt=${scheduledAt}${finalize ? " finalized=one-shot" : ""}`,
      );
      return;
    }
    await this.dispatchAndSettle(automation, runId, "schedule");
  }

  private async dispatchAndSettle(
    automation: ZCodeAutomation,
    runId: string,
    trigger: ZCodeAutomationTrigger,
  ): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(automation);
    this.inFlight.set(runId, { automationId: automation.automationId, workspaceKey, trigger });
    try {
      if (trigger === "schedule") {
        await this.repo.upsertRunClaimed({
          runId,
          automationId: automation.automationId,
          workspaceKey,
          scheduledAt: automation.nextRunAt ?? automation.retryAt ?? Date.now(),
          trigger,
        });
      }
      let taskId: string;
      try {
        taskId = await this.dispatch(automation, runId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarn(
          `${trigger} run dispatch failed automation=${automation.automationId} runId=${runId}: ${message}`,
        );
        await this.settleDispatchFailure(automation, runId, workspaceKey, trigger, message);
        return;
      }
      // 派发已成功：task 已创建、prompt 已被接受，此后台账回写失败只能记日志，
      // 绝不能伪装成派发失败——否则重试会重复创建 task。
      try {
        await this.settleDispatched(automation, runId, taskId, trigger);
      } catch (error) {
        logWarn(
          `回写派发成功状态失败 automation=${automation.automationId} runId=${runId}`,
          error,
        );
      }
      this.watchRunTerminal({
        automation,
        taskId,
        runId,
        scheduledAt: automation.nextRunAt ?? null,
        trigger,
      });
      log(
        `${trigger} run dispatched automation=${automation.automationId} runId=${runId} taskId=${taskId}`,
      );
    } finally {
      this.inFlight.delete(runId);
    }
  }

  private async settleDispatched(
    automation: ZCodeAutomation,
    runId: string,
    taskId: string,
    trigger: ZCodeAutomationTrigger,
  ): Promise<void> {
    const dispatchedAt = Date.now();
    if (trigger === "manual") {
      // manual 不推进 cron 节奏，只累计运行次数；claim 保留到 turn 终态才释放。
      // run 台账的 dispatched 状态由 markManualRunDispatched 原子写入——不能先 markRunDispatch，
      // 否则它「首次进入 dispatched 才累计」的幂等边界会把本次结算吞掉。
      await this.repo.markManualRunDispatched({ runId, sessionId: taskId, dispatchedAt });
      return;
    }
    await this.repo.markRunDispatch({ runId, dispatchStatus: "dispatched", sessionId: taskId });
    const latest = await this.repo.get(automation.automationId);
    await this.repo.markDispatched(automation.automationId, {
      dispatchedAt,
      nextRunAt: latest ? computeAutomationNextRunAt(latest, dispatchedAt) : null,
    });
  }

  private async settleDispatchFailure(
    automation: ZCodeAutomation,
    runId: string,
    workspaceKey: string,
    trigger: ZCodeAutomationTrigger,
    message: string,
  ): Promise<void> {
    try {
      await this.repo.markRunDispatch({
        runId,
        dispatchStatus: "failed_to_dispatch",
        error: message,
      });
      if (trigger === "manual") {
        await this.repo.releaseManualClaim(automation.automationId, workspaceKey);
        return;
      }
      // 对齐 desktop host：派发异常一律 transient，退避重试；达上限后循环任务跳下一个正常触发点。
      const latest = await this.repo.get(automation.automationId);
      await this.repo.markDispatchFailed(automation.automationId, {
        failedAt: Date.now(),
        error: message,
        kind: "transient",
        nextRunAt: latest ? computeAutomationNextRunAt(latest, Date.now()) : null,
      });
    } catch (settleError) {
      logWarn(
        `settle dispatch failure failed automation=${automation.automationId} runId=${runId}`,
        settleError,
      );
    }
  }

  /** 把一次运行提交给 server 自己的 task service；成功后返回派发到的 taskId。 */
  private async dispatch(automation: ZCodeAutomation, runId: string): Promise<string> {
    const taskService = this.taskService;
    if (!taskService) throw new Error("ZCode task service is not initialized.");
    const modelSelectionService = this.modelSelectionService;
    if (!modelSelectionService) throw new Error("Model Selection service is not initialized.");
    return dispatchAutomationRun({
      repo: this.repo,
      taskService,
      modelSelectionService,
      automation,
      runId,
    });
  }

  /** 订阅 turn 终态：回写 run outcome；manual run 在终态才释放 single-flight claim。 */
  private watchRunTerminal(params: {
    automation: ZCodeAutomation;
    taskId: string;
    runId: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
  }): void {
    const taskService = this.taskService;
    if (!taskService) return;
    const watch: RunWatch = {
      taskId: params.taskId,
      runId: params.runId,
      disposed: false,
      heartbeat: undefined,
      subscription: undefined,
    };
    const key = `${params.taskId}:${params.runId}`;
    this.disposeRunWatch(this.runWatches.get(key));
    this.runWatches.set(key, watch);

    if (params.trigger === "manual") {
      const workspaceKey = resolveWorkspaceKey(params.automation);
      watch.heartbeat = setInterval(() => {
        void this.repo.touchManualClaim(params.automation.automationId, workspaceKey).catch((error) =>
          logWarn(
            `续租 manual automation claim 失败 automation=${params.automation.automationId} runId=${params.runId}`,
            error,
          ),
        );
      }, this.manualClaimHeartbeatMs);
    }

    watch.subscription = taskService.onDynamicTaskTerminalOutcome(params.taskId)((result) => {
      if (result.inputId !== params.runId) return;
      void this.settleTerminalOutcome({
        automation: params.automation,
        taskId: params.taskId,
        runId: params.runId,
        scheduledAt: params.scheduledAt,
        trigger: params.trigger,
        outcome: result.outcome,
        ...(result.error ? { error: result.error } : {}),
      }).finally(() => this.disposeRunWatch(watch));
      // 定时任务在后台完成后统一置为未读，真正打开 task 时再由导航链路清除。
      const target = {
        workspacePath: params.automation.workspacePath,
        ...(params.automation.workspaceIdentity
          ? { workspaceIdentity: params.automation.workspaceIdentity }
          : {}),
      };
      void taskService.setTaskUnread({ taskId: params.taskId, ...target, unread: true }).catch(
        (error) => logWarn(`置未读失败 taskId=${params.taskId}`, error),
      );
    });
  }

  private async settleTerminalOutcome(params: TerminalOutcomeParams): Promise<void> {
    const workspaceKey = resolveWorkspaceKey(params.automation);
    try {
      await this.repo.ensureRunClaimed({
        runId: params.runId,
        automationId: params.automation.automationId,
        workspaceKey,
        scheduledAt: params.scheduledAt,
        trigger: params.trigger,
      });
      await this.repo.markRunOutcome(params.runId, params.outcome, params.error);
    } catch (error) {
      logWarn(
        `回写定时任务运行结果失败 automation=${params.automation.automationId} runId=${params.runId}`,
        error,
      );
    }
    if (params.trigger !== "manual") return;
    try {
      await this.repo.releaseManualClaim(params.automation.automationId, workspaceKey);
    } catch (error) {
      logWarn(
        `释放 manual automation claim 失败 automation=${params.automation.automationId} runId=${params.runId}`,
        error,
      );
    }
  }

  private disposeRunWatch(watch: RunWatch | undefined): void {
    if (!watch || watch.disposed) return;
    watch.disposed = true;
    if (watch.heartbeat) clearInterval(watch.heartbeat);
    watch.subscription?.dispose();
    this.runWatches.delete(`${watch.taskId}:${watch.runId}`);
  }
}
