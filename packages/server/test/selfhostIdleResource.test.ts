import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type {
  IZCodeAgentService,
  ZCodeAgentRuntimeLifecycleEvent,
} from "@zcode/services";
import {
  SelfhostIdleResourceManager,
  type SelfhostTaskActivitySource,
} from "../src/selfhostIdleResource.js";

const WORKSPACE_PATH = "/tmp/idle-workspace";

interface FakeAgentService {
  agentService: IZCodeAgentService;
  disposeCalls: string[];
  emitAvailable(): void;
}

function createFakeAgentService(): FakeAgentService {
  const disposeCalls: string[] = [];
  let lifecycleListener: ((event: ZCodeAgentRuntimeLifecycleEvent) => void) | undefined;
  const agentService = {
    onAgentRuntimeLifecycle: (
      listener: (event: ZCodeAgentRuntimeLifecycleEvent) => void,
    ): { dispose(): void } => {
      lifecycleListener = listener;
      return {
        dispose: () => {
          lifecycleListener = undefined;
        },
      };
    },
    // 空闲管理器按 workspace 订阅 telemetry；假实现只提供订阅口，不产生事实。
    onDynamicConversationTelemetryFact:
      () =>
      (_listener: unknown): { dispose(): void } => ({ dispose: () => {} }),
    disposeWorkspace: async (target: { workspacePath: string }): Promise<void> => {
      disposeCalls.push(target.workspacePath);
    },
  } as unknown as IZCodeAgentService;
  return {
    agentService,
    disposeCalls,
    emitAvailable() {
      lifecycleListener?.({
        workspaceKey: WORKSPACE_PATH,
        workspacePath: WORKSPACE_PATH,
        runtimeIdentity: { identity: `${WORKSPACE_PATH}:1:1` },
        state: "available",
      } as ZCodeAgentRuntimeLifecycleEvent);
    },
  };
}

/**
 * 台账快照按调用时刻计算：mock 时钟的起点与真实时钟无关，
 * 只有用调用当下的 Date.now() 做相对时间，宽限期判定才稳定。
 */
function createActivitySource(
  readSnapshot: () => { runningTaskCount: number; lastTaskActivityAt: number | null },
): { source: SelfhostTaskActivitySource; callCount: () => number } {
  let calls = 0;
  return {
    callCount: () => calls,
    source: {
      async readWorkspaceTaskActivity() {
        calls += 1;
        return readSnapshot();
      },
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  // 释放循环要跨过若干 await（台账查询 + dispose），tick 后把微任务放干净。
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function advanceIdleWindow(steps: number): Promise<void> {
  for (let i = 0; i < steps; i += 1) {
    mock.timers.tick(30_000);
    await flushAsyncWork();
  }
}

function startManager(activity: SelfhostTaskActivitySource): {
  manager: SelfhostIdleResourceManager;
  agent: FakeAgentService;
} {
  const agent = createFakeAgentService();
  const manager = new SelfhostIdleResourceManager(
    agent.agentService,
    { idleTimeoutMinutes: 1, pollIntervalMs: 30_000 },
    activity,
  );
  manager.start();
  agent.emitAvailable();
  return { manager, agent };
}

test("台账里仍有运行中的任务时空闲不释放", async (t) => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  t.after(() => mock.timers.reset());
  const activity = createActivitySource(() => ({
    runningTaskCount: 1,
    lastTaskActivityAt: null,
  }));
  const { manager, agent } = startManager(activity.source);

  await advanceIdleWindow(6);

  assert.deepEqual(agent.disposeCalls, []);
  assert.ok(activity.callCount() > 0, "空闲阈值到达后应当查询台账");
  manager.dispose();
});

test("台账刚动过（冷启动宽限期内）空闲不释放", async (t) => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  t.after(() => mock.timers.reset());
  const activity = createActivitySource(() => ({
    runningTaskCount: 0,
    lastTaskActivityAt: Date.now() - 30_000,
  }));
  const { manager, agent } = startManager(activity.source);

  await advanceIdleWindow(4);

  assert.deepEqual(agent.disposeCalls, []);
  assert.ok(activity.callCount() > 0, "空闲阈值到达后应当查询台账");
  manager.dispose();
});

test("台账长时间无活动才释放 workspace", async (t) => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  t.after(() => mock.timers.reset());
  const activity = createActivitySource(() => ({
    runningTaskCount: 0,
    lastTaskActivityAt: Date.now() - 10 * 60_000,
  }));
  const { manager, agent } = startManager(activity.source);

  await advanceIdleWindow(4);

  assert.deepEqual(agent.disposeCalls, [WORKSPACE_PATH]);
  manager.dispose();
});

test("台账读取失败按活跃处理，不释放", async (t) => {
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  t.after(() => mock.timers.reset());
  const source: SelfhostTaskActivitySource = {
    async readWorkspaceTaskActivity() {
      throw new Error("tasks-index unavailable");
    },
  };
  const { manager, agent } = startManager(source);

  await advanceIdleWindow(4);

  assert.deepEqual(agent.disposeCalls, []);
  manager.dispose();
});
