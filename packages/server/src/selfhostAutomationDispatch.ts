import type { AutomationRepo } from "@zcode/services/node";
import type { IModelSelectionService, IZCodeTaskService } from "@zcode/services";
import {
  formatModelPickerValue,
  resolveWorkspaceKey,
  type ModelSelection,
  type ZCodeAutomation,
} from "@zcode/shared";

/**
 * 自托管 `--web` 的 automation 派发：把一次运行提交给 server 自己的 task service。
 *
 * 对齐 desktop host 的 `dispatchCronRun`：run 参数在派发边界固定、绑定会话先 resume 再套用
 * 本次运行参数、prompt 用 runId 作 traceId；不搬 desktop 专属的 Bot 回推与 session_create 遥测。
 */

/** 运行参数在派发边界固定：只有首个 run 解析一次（或读回已固定值），transient 重试复用同一选择。 */
async function resolveDispatchModelSelection(params: {
  automation: ZCodeAutomation;
  fixedSelection?: ModelSelection;
  modelSelectionService: IModelSelectionService;
  readSelection: () => Promise<ModelSelection | undefined>;
}): Promise<ModelSelection> {
  // 已固定 run 是执行事实；重试不能重新对应账号，更不能被当前读取失败改变。
  if (params.fixedSelection) return params.fixedSelection;
  const selection = (await params.readSelection()) ?? params.automation.modelSelection;
  if (selection) {
    const view = await params.modelSelectionService.getView({ selection });
    if (view.selectionIssue || !view.effectiveSelection?.options?.reasoningLevel) {
      throw new Error("Automation 模型选择不可用，请重新选择模型与思考档位");
    }
    return view.effectiveSelection;
  }
  const preferredSelection = (await params.modelSelectionService.getView()).preferredSelection;
  if (!preferredSelection?.options?.reasoningLevel) {
    throw new Error("Automation 无法解析首选模型");
  }
  return preferredSelection;
}

/** 提交一次 automation 运行；prompt 已被 session 接受后返回派发到的 taskId。 */
export async function dispatchAutomationRun(params: {
  repo: AutomationRepo;
  taskService: IZCodeTaskService;
  modelSelectionService: IModelSelectionService;
  automation: ZCodeAutomation;
  runId: string;
}): Promise<string> {
  const { automation, runId } = params;
  const existingRun = await params.repo.getRun(runId);
  const selection = await resolveDispatchModelSelection({
    automation,
    ...(existingRun?.modelSelection ? { fixedSelection: existingRun.modelSelection } : {}),
    modelSelectionService: params.modelSelectionService,
    readSelection: () =>
      params.repo.getModelSelectionForDispatch(
        automation.automationId,
        resolveWorkspaceKey(automation),
      ),
  });
  await params.repo.fixRunModelSelection(runId, selection);

  const target = {
    workspacePath: automation.workspacePath,
    ...(automation.workspaceIdentity ? { workspaceIdentity: automation.workspaceIdentity } : {}),
  };
  let taskId = automation.targetTaskId;
  if (taskId) {
    // 绑定会话：后续触发都投递回原 task，不新建 session；旧会话重启后可能不在 active，
    // 必须先 resume 再套用本次运行参数。
    await params.taskService.resumeTask({
      taskId,
      ...target,
      model: formatModelPickerValue(selection),
      ...(selection.options?.reasoningLevel
        ? { thoughtLevel: selection.options.reasoningLevel }
        : {}),
      ...(automation.mode ? { mode: automation.mode } : {}),
      automationId: automation.automationId,
    });
    await params.taskService.setAutomationSessionConfig({
      taskId,
      traceId: runId,
      modelSelection: selection,
      ...(selection.options?.reasoningLevel
        ? { thoughtLevel: selection.options.reasoningLevel }
        : {}),
      ...(automation.mode ? { mode: automation.mode } : {}),
    });
  } else {
    const created = await params.taskService.createTask({
      ...target,
      modelSelection: selection,
      ...(automation.mode ? { mode: automation.mode } : {}),
      automationId: automation.automationId,
    });
    taskId = created.taskId;
  }

  await params.taskService.sendPrompt({
    taskId,
    traceId: runId,
    content: automation.prompt,
    clientMode: "desktop-continuous",
    automationId: automation.automationId,
  });
  // 后台派发的任务统一置未读，用户真正打开 task 时再由导航链路清除。
  await params.taskService.setTaskUnread({ taskId, ...target, unread: true });
  return taskId;
}
