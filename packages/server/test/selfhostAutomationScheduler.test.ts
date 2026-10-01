import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationRepo } from "@zcode/services/node";
import type { IModelSelectionService, IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskTerminalOutcome } from "@zcode/services";
import { SelfhostAutomationScheduler } from "../src/selfhostAutomationScheduler.js";

const SELECTION = {
  providerId: "provider-1",
  modelId: "model-1",
  options: { reasoningLevel: "medium" },
};

const MODEL_SELECTION_SERVICE = {
  onDidChange: () => ({ dispose: () => {} }),
  getView: async () => ({
    preferredSelection: SELECTION,
    effectiveSelection: SELECTION,
    selectionIssue: undefined,
  }),
} as unknown as IModelSelectionService;

interface FakeTaskCalls {
  createTask: Array<{ workspacePath: string; automationId?: string }>;
  resumeTask: Array<{ taskId: string }>;
  setAutomationSessionConfig: Array<{ taskId: string; traceId: string }>;
  sendPrompt: Array<{ taskId: string; traceId: string; content: string; automationId?: string }>;
  setTaskUnread: Array<{ taskId: string; unread: boolean }>;
}

function makeFakeTaskService(): {
  service: IZCodeTaskService;
  calls: FakeTaskCalls;
  failCreateTask: { value: boolean };
  emitTerminalOutcome: (taskId: string, outcome: ZCodeTaskTerminalOutcome) => void;
} {
  const calls: FakeTaskCalls = {
    createTask: [],
    resumeTask: [],
    setAutomationSessionConfig: [],
    sendPrompt: [],
    setTaskUnread: [],
  };
  const failCreateTask = { value: false };
  const terminalListeners = new Map<string, Array<(outcome: ZCodeTaskTerminalOutcome) => void>>();
  let createdCount = 0;
  const service = {
    async createTask(params: { workspacePath: string; automationId?: string }) {
      calls.createTask.push(params);
      if (failCreateTask.value) throw new Error("agent runtime unavailable");
      createdCount += 1;
      return { taskId: `task-${createdCount}` };
    },
    async resumeTask(params: { taskId: string }) {
      calls.resumeTask.push(params);
    },
    async setAutomationSessionConfig(params: { taskId: string; traceId: string }) {
      calls.setAutomationSessionConfig.push(params);
    },
    async sendPrompt(params: { taskId: string; traceId: string; content: string }) {
      calls.sendPrompt.push(params);
    },
    async setTaskUnread(params: { taskId: string; unread: boolean }) {
      calls.setTaskUnread.push(params);
    },
    onDynamicTaskTerminalOutcome(taskId: string) {
      return (listener: (outcome: ZCodeTaskTerminalOutcome) => void) => {
        const listeners = terminalListeners.get(taskId) ?? [];
        listeners.push(listener);
        terminalListeners.set(taskId, listeners);
        return {
          dispose: () => {
            terminalListeners.set(
              taskId,
              (terminalListeners.get(taskId) ?? []).filter((item) => item !== listener),
            );
          },
        };
      };
    },
  } as unknown as IZCodeTaskService;
  return {
    service,
    calls,
    failCreateTask,
    emitTerminalOutcome(taskId, outcome) {
      for (const listener of terminalListeners.get(taskId) ?? []) listener(outcome);
    },
  };
}

interface Harness {
  repo: AutomationRepo;
  scheduler: SelfhostAutomationScheduler;
  calls: FakeTaskCalls;
  failCreateTask: { value: boolean };
  emitTerminalOutcome: (taskId: string, outcome: ZCodeTaskTerminalOutcome) => void;
  cleanup: () => Promise<void>;
}

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "selfhost-automation-"));
  const dbPath = join(dir, "tasks-index.sqlite");
  const task = makeFakeTaskService();
  const repo = new AutomationRepo(dbPath);
  const scheduler = new SelfhostAutomationScheduler({
    taskService: task.service,
    modelSelectionService: MODEL_SELECTION_SERVICE,
    dbPath,
    misfireGraceMs: 5 * 60_000,
    manualClaimHeartbeatMs: 50,
  });
  return {
    repo,
    scheduler,
    calls: task.calls,
    failCreateTask: task.failCreateTask,
    emitTerminalOutcome: task.emitTerminalOutcome,
    async cleanup() {
      await scheduler.dispose();
      repo.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timeout waiting for ${label}`);
}

test("到期的循环任务被认领并真实派发", async () => {
  const { repo, scheduler, calls, cleanup } = makeHarness();
  try {
    const automation = await repo.create(
      { title: "每日", cronExpr: "0 9 * * *", prompt: "跑一遍", workspacePath: "/ws", recurring: true },
      { nextRunAt: Date.now() - 1_000 },
    );
    await scheduler.tick();

    assert.equal(calls.createTask.length, 1);
    assert.equal(calls.createTask[0]!.workspacePath, "/ws");
    assert.equal(calls.createTask[0]!.automationId, automation.automationId);
    assert.equal(calls.sendPrompt.length, 1);
    assert.equal(calls.sendPrompt[0]!.content, "跑一遍");
    assert.deepEqual(calls.setTaskUnread, [
      { taskId: "task-1", workspacePath: "/ws", unread: true },
    ]);

    const after = await repo.get(automation.automationId);
    assert.equal(after?.runCount, 1);
    assert.equal(after?.dispatchStatus, "dispatched");
    assert.ok((after?.nextRunAt ?? 0) > Date.now(), "next_run_at 前推到下一个未来触发点");

    const runs = await repo.listRuns(automation.automationId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.dispatchStatus, "dispatched");
    assert.equal(runs[0]!.trigger, "schedule");
    assert.equal(runs[0]!.sessionId, "task-1");
  } finally {
    await cleanup();
  }
});

test("错过窗口的循环任务记 skipped 不补跑", async () => {
  const { repo, scheduler, calls, cleanup } = makeHarness();
  try {
    const automation = await repo.create(
      { title: "每日", cronExpr: "0 9 * * *", prompt: "跑一遍", workspacePath: "/ws", recurring: true },
      { nextRunAt: Date.now() - 10 * 60_000 },
    );
    await scheduler.tick();

    assert.equal(calls.createTask.length, 0);
    assert.equal(calls.sendPrompt.length, 0);
    const runs = await repo.listRuns(automation.automationId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.dispatchStatus, "skipped");
    assert.equal(runs[0]!.error, "server_not_running");
    const after = await repo.get(automation.automationId);
    assert.equal(after?.runCount, 0);
    assert.equal(after?.dispatchStatus, "idle");
    assert.ok((after?.nextRunAt ?? 0) > Date.now());
  } finally {
    await cleanup();
  }
});

test("一次性任务错过窗口直接进终态", async () => {
  const { repo, scheduler, calls, cleanup } = makeHarness();
  try {
    const automation = await repo.create(
      {
        title: "提醒",
        cronExpr: "* * * * *",
        prompt: "提醒我",
        workspacePath: "/ws",
        recurring: false,
        maxRuns: 1,
      },
      { nextRunAt: Date.now() - 10 * 60_000 },
    );
    await scheduler.tick();

    assert.equal(calls.createTask.length, 0);
    const after = await repo.get(automation.automationId);
    assert.equal(after?.lifecycleStatus, "completed");
    assert.equal(after?.enabled, false);
    assert.equal(after?.nextRunAt, undefined);
  } finally {
    await cleanup();
  }
});

test("派发失败写 transient 退避，退避期内不重复认领", async () => {
  const { repo, scheduler, calls, failCreateTask, cleanup } = makeHarness();
  try {
    const automation = await repo.create(
      { title: "每日", cronExpr: "0 9 * * *", prompt: "跑一遍", workspacePath: "/ws", recurring: true },
      { nextRunAt: Date.now() - 1_000 },
    );
    failCreateTask.value = true;
    await scheduler.tick();

    const after = await repo.get(automation.automationId);
    assert.equal(after?.dispatchStatus, "failed_to_dispatch");
    assert.equal(after?.dispatchAttempts, 1);
    assert.ok((after?.retryAt ?? 0) > Date.now(), "写入退避 retry_at");
    assert.match(after?.lastError ?? "", /agent runtime unavailable/);
    const runs = await repo.listRuns(automation.automationId);
    assert.equal(runs[0]!.dispatchStatus, "failed_to_dispatch");

    // 退避到期前再次 tick：不得绕过退避重复认领。
    await scheduler.tick();
    assert.equal(calls.createTask.length, 1);
    assert.equal((await repo.get(automation.automationId))?.dispatchAttempts, 1);
  } finally {
    await cleanup();
  }
});

test("立即运行派发成功且不污染 cron 节奏，claim 在 turn 终态释放", async () => {
  const { repo, scheduler, calls, emitTerminalOutcome, cleanup } = makeHarness();
  try {
    const nextRunAt = Date.now() + 60 * 60_000;
    const automation = await repo.create(
      { title: "每日", cronExpr: "0 9 * * *", prompt: "跑一遍", workspacePath: "/ws", recurring: true },
      { nextRunAt },
    );
    const claimed = await repo.runNow(automation.automationId, { now: Date.now() });
    assert.ok(claimed, "manual run 应被认领");
    await scheduler.dispatchManualRun(claimed);

    const afterDispatch = await repo.get(automation.automationId);
    assert.equal(afterDispatch?.runCount, 1);
    assert.equal(afterDispatch?.nextRunAt, nextRunAt, "manual run 不推进 next_run_at");
    const run = await repo.getRun(claimed.run.runId);
    assert.equal(run?.trigger, "manual");
    assert.equal(run?.dispatchStatus, "dispatched");
    assert.equal(calls.createTask.length, 1);

    // claim 覆盖排队 + 整个 turn：终态前同一 automation 不允许再次手动触发。
    assert.equal(await repo.runNow(automation.automationId, { now: Date.now() }), null);

    emitTerminalOutcome("task-1", { taskId: "task-1", inputId: claimed.run.runId, outcome: "succeeded" });
    await waitFor(
      async () => (await repo.getRun(claimed.run.runId))?.outcome === "succeeded",
      "manual run 终态回写",
    );
    await waitFor(async () => {
      const again = await repo.runNow(automation.automationId, { now: Date.now() });
      return again !== null;
    }, "manual claim 释放");
  } finally {
    await cleanup();
  }
});
