import type {
  IZCodeAgentService,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentWorkspaceTarget,
} from "@zcode/services";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import type { IDisposable } from "@zcode/rpc";

/**
 * 自托管 `--web` 的空闲资源管理：唯一所有者。
 *
 * 空闲定义：WS 连接数为 0 且 Agent 无活跃任务持续超过阈值。
 * 进入空闲时调用 `disposeWorkspace` 释放 Agent 子进程内存；会话落库数据不受影响，
 * 下一次请求按 services 现有的 single-flight 正常重建 runtime。
 *
 * 为什么是轮询 + 计数器而不是事件驱动 dispose：
 * turn 事件与 WS 开关是高频信号，直接在回调里做 dispose 会在任务刚结束、
 * 用户马上又发消息的间隙误杀 runtime。用“条件持续成立 N 秒”做去抖，
 * 误杀只发生在用户真的离开超过阈值之后。
 */
export interface SelfhostIdleResourceOptions {
  /** 空闲阈值分钟数，默认 30；0 表示关闭空闲释放。 */
  idleTimeoutMinutes?: number;
  /** 轮询节拍毫秒，默认 30s。轮询只读内存态计数器，无 IO。 */
  pollIntervalMs?: number;
}

/**
 * 任务台账（tasks-index）口径的 workspace 活跃快照，供空闲释放做二次确认。
 *
 * 为什么需要它：内存计数器只认已经开始的 turn。定时任务/闲时任务从派发到
 * turn 开始之间有几秒（Agent 冷启动更久）没有 turn 事件，页面又早已关闭，
 * 空闲阈值正好落在这一窗口时会杀掉刚起来的 Agent，任务当场中断。
 */
export interface SelfhostTaskActivitySource {
  /** 读取失败必须抛错：调用方按“活跃”处理，宁可晚释放也不能杀任务。 */
  readWorkspaceTaskActivity(target: ZCodeAgentWorkspaceTarget): Promise<{
    /** 台账里仍标记 running、或阻塞在交互上的任务数。 */
    runningTaskCount: number;
    /** 最近一次任务变更时间（毫秒）；无任务时为 null。 */
    lastTaskActivityAt: number | null;
  }>;
}

export interface SelfhostResourceSnapshot {
  serverRssBytes: number;
  serverHeapUsedBytes: number;
  serverUptimeSeconds: number;
  wsConnectionCount: number;
  runningTaskCount: number;
  /** 距离空闲释放的剩余秒数；空闲释放关闭或当前不满足空闲条件时为 null。 */
  idleCountdownSeconds: number | null;
  idleTimeoutMinutes: number;
}

const DEFAULT_IDLE_TIMEOUT_MINUTES = 30;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
/**
 * 台账上“刚刚动过”的任务视为活跃的宽限期。
 * 覆盖派发到 turn 开始之间的冷启动窗口，以及 turn 结束后台账落盘的最后一步。
 */
const TASK_ACTIVITY_GRACE_MS = 3 * 60_000;

function resolveIdleTimeoutMinutes(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_IDLE_TIMEOUT_MINUTES;
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_IDLE_TIMEOUT_MINUTES;
  return Math.floor(raw);
}

function resolvePollIntervalMs(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.floor(raw);
}

function workspaceKeyOf(target: ZCodeAgentWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

export class SelfhostIdleResourceManager implements IDisposable {
  private readonly agentService: IZCodeAgentService | undefined;
  private readonly taskActivitySource: SelfhostTaskActivitySource | undefined;
  private readonly idleTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly activeSessionIdsByWorkspace = new Map<string, Set<string>>();
  private readonly workspaceTargets = new Map<string, ZCodeAgentWorkspaceTarget>();
  private readonly workspaceRuntimeIdentities = new Map<string, string>();
  private readonly telemetryDisposables = new Map<string, IDisposable>();
  private lifecycleDisposable: IDisposable | undefined;
  private idleSinceMs: number | undefined;
  private releasedWhileIdle = false;
  // 释放循环自身可能跨过下一次轮询节拍（每个 workspace 都要等一次台账查询），
  // 用它挡住重入，避免同一轮空闲里对同一个 workspace 调两次 dispose。
  private releasing = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private wsConnectionCount = 0;

  constructor(
    agentService: IZCodeAgentService | undefined,
    options: SelfhostIdleResourceOptions = {},
    taskActivitySource?: SelfhostTaskActivitySource,
  ) {
    this.agentService = agentService;
    this.taskActivitySource = taskActivitySource;
    this.idleTimeoutMs = resolveIdleTimeoutMinutes(options.idleTimeoutMinutes) * 60_000;
    this.pollIntervalMs = resolvePollIntervalMs(options.pollIntervalMs);
  }

  start(): void {
    if (this.disposed || this.timer) return;
    this.lifecycleDisposable = this.agentService?.onAgentRuntimeLifecycle?.((event) =>
      this.acceptLifecycle(event),
    );
    // 空闲计时器不能把 server 进程钉在事件循环里。
    this.timer = setInterval(() => {
      void this.poll().catch(() => undefined);
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  /** `/ws` 连接开关由 http 层通知；可信 `/ws/host` 通道不计入。 */
  notifyWsOpened(): void {
    this.wsConnectionCount += 1;
    this.idleSinceMs = undefined;
    this.releasedWhileIdle = false;
  }

  notifyWsClosed(): void {
    this.wsConnectionCount = Math.max(0, this.wsConnectionCount - 1);
  }

  readSnapshot(): SelfhostResourceSnapshot {
    const memory = process.memoryUsage();
    return {
      serverRssBytes: memory.rss,
      serverHeapUsedBytes: memory.heapUsed,
      serverUptimeSeconds: Math.floor(process.uptime()),
      wsConnectionCount: this.wsConnectionCount,
      runningTaskCount: this.readRunningTaskCount(),
      idleCountdownSeconds: this.readIdleCountdownSeconds(Date.now()),
      idleTimeoutMinutes: Math.floor(this.idleTimeoutMs / 60_000),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.lifecycleDisposable?.dispose();
    for (const disposable of this.telemetryDisposables.values()) disposable.dispose();
    this.telemetryDisposables.clear();
    this.activeSessionIdsByWorkspace.clear();
    this.workspaceTargets.clear();
    this.workspaceRuntimeIdentities.clear();
  }

  private readRunningTaskCount(): number {
    let total = 0;
    for (const sessionIds of this.activeSessionIdsByWorkspace.values()) total += sessionIds.size;
    return total;
  }

  private readIdleCountdownSeconds(nowMs: number): number | null {
    if (this.idleTimeoutMs <= 0 || this.releasedWhileIdle) return null;
    if (this.wsConnectionCount > 0 || this.readRunningTaskCount() > 0) return null;
    if (this.idleSinceMs === undefined) return Math.ceil(this.idleTimeoutMs / 1000);
    const remainingMs = this.idleSinceMs + this.idleTimeoutMs - nowMs;
    return Math.max(0, Math.ceil(remainingMs / 1000));
  }

  private acceptLifecycle(event: ZCodeAgentRuntimeLifecycleEvent): void {
    if (this.disposed) return;
    const key = event.workspaceKey || workspaceKeyOf(event);
    if (event.state === "unavailable") {
      this.removeWorkspace(key, event.runtimeIdentity.identity);
      return;
    }
    // runtime 换代时旧订阅先清掉再重建，避免旧 runtime 的迟到 turn.terminal
    // 把新 runtime 的活跃会话误删。
    this.removeWorkspace(key);
    const telemetry = this.agentService?.onDynamicConversationTelemetryFact(event);
    if (!telemetry) return;
    const disposable = telemetry((fact) => this.acceptFact(key, fact));
    this.telemetryDisposables.set(key, disposable);
    this.activeSessionIdsByWorkspace.set(key, new Set());
    this.workspaceRuntimeIdentities.set(key, event.runtimeIdentity.identity);
    this.workspaceTargets.set(key, {
      ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
      workspacePath: event.workspacePath,
    });
  }

  private acceptFact(key: string, fact: ConversationTelemetryFact): void {
    const sessionIds = this.activeSessionIdsByWorkspace.get(key);
    if (!sessionIds) return;
    if (fact.kind === "turn.started") {
      sessionIds.add(fact.sessionId);
      this.idleSinceMs = undefined;
      this.releasedWhileIdle = false;
    } else if (fact.kind === "turn.terminal") {
      sessionIds.delete(fact.sessionId);
    }
  }

  private removeWorkspace(key: string, runtimeIdentity?: string): void {
    const current = this.activeSessionIdsByWorkspace.get(key);
    if (!current) return;
    // 换代时的 unavailable 只清旧代：identity 对不上说明是旧 runtime 的迟到事件，
    // 不能把新 runtime 的计数清掉。
    if (
      runtimeIdentity !== undefined &&
      this.workspaceRuntimeIdentities.get(key) !== runtimeIdentity
    ) {
      return;
    }
    this.telemetryDisposables.get(key)?.dispose();
    this.telemetryDisposables.delete(key);
    this.activeSessionIdsByWorkspace.delete(key);
    this.workspaceTargets.delete(key);
    this.workspaceRuntimeIdentities.delete(key);
  }

  private async poll(): Promise<void> {
    if (this.disposed || this.idleTimeoutMs <= 0) return;
    if (this.wsConnectionCount > 0 || this.readRunningTaskCount() > 0) {
      this.idleSinceMs = undefined;
      return;
    }
    const nowMs = Date.now();
    if (this.idleSinceMs === undefined) {
      this.idleSinceMs = nowMs;
      return;
    }
    if (nowMs - this.idleSinceMs < this.idleTimeoutMs || this.releasedWhileIdle) return;
    await this.releaseIdleWorkspaces(nowMs);
  }

  private async releaseIdleWorkspaces(nowMs: number): Promise<void> {
    if (!this.agentService || this.releasing) return;
    this.releasing = true;
    try {
      await this.releaseIdleWorkspacesOnce(nowMs);
    } finally {
      this.releasing = false;
    }
  }

  private async releaseIdleWorkspacesOnce(nowMs: number): Promise<void> {
    const agentService = this.agentService;
    if (!agentService) return;
    let releasedCount = 0;
    let activeCount = 0;
    for (const [key, target] of this.workspaceTargets) {
      if (await this.isWorkspaceActive(target, nowMs)) {
        activeCount += 1;
        continue;
      }
      try {
        // disposeWorkspace 只杀 Agent 进程树，会话落库数据保留；
        // 失败只记日志，不重试、不崩进程，等下一次活跃后重新计时。
        await agentService.disposeWorkspace(target);
        releasedCount += 1;
        console.info("[zcode-server:selfhost-idle] released idle workspace", {
          workspaceKey: key,
          idleMs: nowMs - (this.idleSinceMs ?? nowMs),
        });
      } catch (error) {
        console.warn("[zcode-server:selfhost-idle] disposeWorkspace failed", {
          workspacePath: target.workspacePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // 还有 workspace 在跑任务时不能锁死空闲态：重置计时，下一轮重新评估。
    if (activeCount > 0) {
      this.idleSinceMs = nowMs;
      return;
    }
    if (releasedCount > 0) this.releasedWhileIdle = true;
  }

  /**
   * 释放前的二次确认：内存计数只认已经开始的 turn，台账才是“这个 workspace 还有活”的最终依据。
   * 台账读取失败按活跃处理——多占一会儿内存，也好过杀掉正在跑的任务。
   */
  private async isWorkspaceActive(
    target: ZCodeAgentWorkspaceTarget,
    nowMs: number,
  ): Promise<boolean> {
    if (!this.taskActivitySource) return false;
    try {
      const activity = await this.taskActivitySource.readWorkspaceTaskActivity(target);
      if (activity.runningTaskCount > 0) return true;
      return (
        activity.lastTaskActivityAt !== null &&
        nowMs - activity.lastTaskActivityAt < TASK_ACTIVITY_GRACE_MS
      );
    } catch (error) {
      console.warn("[zcode-server:selfhost-idle] read task activity failed", {
        workspacePath: target.workspacePath,
        reason: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }
}

export function resolveSelfhostIdleTimeoutMinutes(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env["ZCODE_SELFHOST_IDLE_TIMEOUT_MINUTES"]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}
