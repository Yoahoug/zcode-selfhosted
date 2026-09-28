import assert from "node:assert/strict";
import test from "node:test";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { createSelfhostTaskListController } from "../src/selfhostTaskListController.js";

function makeMeta(overrides: Partial<ZCodeTaskMeta> & { taskId: string }): ZCodeTaskMeta {
  return {
    traceId: `trace-${overrides.taskId}`,
    title: overrides.taskId,
    workspacePath: "/ws",
    createdAt: 1,
    updatedAt: 1,
    mode: "build",
    ...overrides,
  };
}

// fake taskService 按分区返回固定数据：调用方传什么分区，返回什么集合。
// 归属判定在 Controller 侧按分区来源决定，不读 meta 字段（meta 无 pinned/archived）。
function makeFakeTaskService(): {
  service: IZCodeTaskService;
  calls: { archived: number; pinned: number; plain: number; search: number };
} {
  const archived = [makeMeta({ taskId: "a1", updatedAt: 30 })];
  const pinned = [makeMeta({ taskId: "p1", updatedAt: 20 })];
  const plain = [makeMeta({ taskId: "t1", updatedAt: 10 })];
  const calls = { archived: 0, pinned: 0, plain: 0, search: 0 };
  const service = {
    async listArchivedTasks() {
      calls.archived += 1;
      return archived;
    },
    async listPinnedTasks() {
      calls.pinned += 1;
      return pinned;
    },
    async listTasks() {
      calls.plain += 1;
      return plain;
    },
    async listTaskList() {
      calls.search += 1;
      return { items: [...archived, ...pinned, ...plain], total: 3, hasMore: false };
    },
    async deleteArchivedTask() {
      return true;
    },
    async deleteArchivedTasks(params: { taskIds: string[] }) {
      return { deletedTaskIds: params.taskIds, skippedTaskIds: [], failedTaskIds: [] };
    },
    async unarchiveTask(params: { taskId: string; workspacePath: string }) {
      return makeMeta({ taskId: params.taskId, workspacePath: params.workspacePath });
    },
  } as unknown as IZCodeTaskService;
  return { service, calls };
}

const scope = { workspacePath: "/ws" };

test("archived kind 只返回归档分区", async () => {
  const { service } = makeFakeTaskService();
  const controller = createSelfhostTaskListController(service);
  const result = await controller.listTaskList({
    kind: "archived",
    workspaceScopes: [scope],
    sortBy: "updated",
  });
  assert.deepEqual(
    result.items.map((item) => item.taskId),
    ["a1"],
  );
  assert.equal(result.total, 1);
  assert.equal(result.hasMore, false);
  assert.equal(result.items[0]?.sourceAvailability, "online");
});

test("timeline kind 只返回未归档非 pinned 分区", async () => {
  const { service } = makeFakeTaskService();
  const controller = createSelfhostTaskListController(service);
  const result = await controller.listTaskList({
    kind: "timeline",
    workspaceScopes: [scope],
    sortBy: "updated",
  });
  assert.deepEqual(
    result.items.map((item) => item.taskId),
    ["t1"],
  );
});

test("active kind 合并未归档两路并按 updated 排序", async () => {
  const { service } = makeFakeTaskService();
  const controller = createSelfhostTaskListController(service);
  const result = await controller.listTaskList({
    kind: "active",
    workspaceScopes: [scope],
    sortBy: "updated",
  });
  assert.deepEqual(
    result.items.map((item) => item.taskId),
    ["p1", "t1"],
  );
  assert.equal(result.total, 2);
});

test("limit 裁剪后 hasMore 为 true", async () => {
  const { service } = makeFakeTaskService();
  const controller = createSelfhostTaskListController(service);
  const result = await controller.listTaskList({
    kind: "active",
    workspaceScopes: [scope],
    sortBy: "updated",
    limit: 1,
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.total, 2);
  assert.equal(result.hasMore, true);
});

test("taskService 缺失时返回空列表而不是抛错", async () => {
  const controller = createSelfhostTaskListController(undefined);
  const result = await controller.listTaskList({
    kind: "archived",
    workspaceScopes: [scope],
    sortBy: "updated",
  });
  assert.deepEqual(result, { items: [], total: 0, hasMore: false });
});

test("deleteArchivedTasks 空批次直接返回空结果", async () => {
  const { service } = makeFakeTaskService();
  const controller = createSelfhostTaskListController(service);
  const result = await controller.deleteArchivedTasks({
    address: { workspacePath: "/ws", taskId: "a1" },
    taskIds: [],
  });
  assert.deepEqual(result, { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] });
});

test("mutateTask archive=false 直透 unarchiveTask", async () => {
  const { service } = makeFakeTaskService();
  const controller = createSelfhostTaskListController(service);
  const meta = await controller.mutateTask({
    address: { workspacePath: "/ws", taskId: "a1" },
    mutation: { kind: "archive", archived: false },
  });
  assert.equal(meta?.taskId, "a1");
});

test("订阅返回 snapshot ack 且帧流为空", async () => {
  const { service } = makeFakeTaskService();
  const controller = createSelfhostTaskListController(service);
  const subscribed = await controller.subscribeControllerV4({ topic: "controller/tasks-index" });
  assert.equal(subscribed.ack.mode, "snapshot");
  assert.ok(subscribed.ack.subscriptionId.length > 0);
  assert.ok(subscribed.ack.logEpoch.length > 0);
  let fired = false;
  const disposable = controller.onDynamicControllerFrame()(() => {
    fired = true;
  });
  disposable.dispose();
  assert.equal(fired, false);
});
