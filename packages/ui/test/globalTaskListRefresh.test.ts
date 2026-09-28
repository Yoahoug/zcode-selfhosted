import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeWorkspaceEvent } from "@zcode/shared";
import {
  createCoalescedRefreshScheduler,
  shouldRefreshGlobalTaskListOnWorkspaceEvent,
} from "../src/lib/globalTaskListRefresh.js";

const WORKSPACE_PATH = "/data/appdata/zcode-web/workspace";
const CONVERSATION_PATH = "/data/appdata/zcode-web/data/.zcode/workspace/default";

function workspaceEvent(
  overrides: Partial<Extract<ZCodeWorkspaceEvent, { type: "workspace_task_list_changed" }>> = {},
): ZCodeWorkspaceEvent {
  return {
    type: "workspace_task_list_changed",
    workspacePath: WORKSPACE_PATH,
    reason: "task_archived",
    ...overrides,
  } as ZCodeWorkspaceEvent;
}

test("membership 事件命中本 scope 时要求刷新", () => {
  const scope = { workspacePath: WORKSPACE_PATH };
  assert.equal(shouldRefreshGlobalTaskListOnWorkspaceEvent(workspaceEvent(), scope), true);
});

test("其它 workspace 的事件不触发刷新", () => {
  const scope = { workspacePath: WORKSPACE_PATH };
  assert.equal(
    shouldRefreshGlobalTaskListOnWorkspaceEvent(
      workspaceEvent({ workspacePath: CONVERSATION_PATH }),
      scope,
    ),
    false,
  );
});

test("workspaceIdentity 隔离：identity 不同不触发，相同才触发", () => {
  const scope = { workspacePath: WORKSPACE_PATH, workspaceIdentity: "host-a" };
  assert.equal(
    shouldRefreshGlobalTaskListOnWorkspaceEvent(
      workspaceEvent({ workspaceIdentity: "host-b" }),
      scope,
    ),
    false,
  );
  assert.equal(
    shouldRefreshGlobalTaskListOnWorkspaceEvent(
      workspaceEvent({ workspaceIdentity: "host-a" }),
      scope,
    ),
    true,
  );
});

test("与归属无关的事件类型/原因不触发刷新", () => {
  const scope = { workspacePath: WORKSPACE_PATH };
  assert.equal(
    shouldRefreshGlobalTaskListOnWorkspaceEvent(
      workspaceEvent({ reason: "task_model_changed" }),
      scope,
    ),
    false,
  );
  assert.equal(
    shouldRefreshGlobalTaskListOnWorkspaceEvent(
      {
        type: "workspace_config_options_update",
        workspacePath: WORKSPACE_PATH,
      } as ZCodeWorkspaceEvent,
      scope,
    ),
    false,
  );
});

test("删除 / 取消归档等持久化归属事件同样触发刷新", () => {
  const scope = { workspacePath: WORKSPACE_PATH };
  for (const reason of [
    "task_unarchived",
    "task_deleted",
    "task_meta_changed",
    "task_created",
  ] as const) {
    assert.equal(
      shouldRefreshGlobalTaskListOnWorkspaceEvent(workspaceEvent({ reason }), scope),
      true,
      `reason=${reason}`,
    );
  }
});

test("连续事件在窗口内合并为一次刷新", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let refreshCount = 0;
  const scheduler = createCoalescedRefreshScheduler(() => {
    refreshCount += 1;
  });
  scheduler.schedule();
  scheduler.schedule();
  scheduler.schedule();
  assert.equal(refreshCount, 0, "窗口内不应立即刷新");
  t.mock.timers.tick(50);
  assert.equal(refreshCount, 1, "窗口结束后应恰好刷新一次");
  t.mock.timers.tick(500);
  assert.equal(refreshCount, 1, "没有新事件时不应重复刷新");
  scheduler.dispose();
});

test("窗口结束后到达的新事件可以再次调度刷新", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let refreshCount = 0;
  const scheduler = createCoalescedRefreshScheduler(() => {
    refreshCount += 1;
  });
  scheduler.schedule();
  t.mock.timers.tick(50);
  scheduler.schedule();
  t.mock.timers.tick(50);
  assert.equal(refreshCount, 2);
  scheduler.dispose();
});

test("dispose 丢弃已排程的刷新，避免卸载后触发", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let refreshCount = 0;
  const scheduler = createCoalescedRefreshScheduler(() => {
    refreshCount += 1;
  });
  scheduler.schedule();
  scheduler.dispose();
  t.mock.timers.tick(50);
  assert.equal(refreshCount, 0);
});
