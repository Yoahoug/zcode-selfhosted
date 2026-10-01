import { createLocalServices, getAppConfigDir } from "@zcode/services/node";
import { IModelSelectionService, IZCodeTaskService } from "@zcode/services";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer } from "./http.js";
import {
  SelfhostAutomationScheduler,
  resolveSelfhostAutomationSchedulerEnabled,
} from "./selfhostAutomationScheduler.js";

async function main(): Promise<void> {
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  // 定时任务调度器与 services 互相引用：manual run 的派发入口必须在 createLocalServices
  // 装配时注入，调度器本体又要在装配后从 services 取 task / model selection 服务。
  // 用前向引用 holder 惰性绑定——manual run 只会在装配完成后由 RPC 触发。
  let automationScheduler: SelfhostAutomationScheduler | undefined;
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
    onAutomationManualRunRequested: async ({ automation, run }) => {
      if (!automationScheduler) {
        throw new Error("Automation immediate dispatcher is unavailable.");
      }
      await automationScheduler.dispatchManualRun({ automation, run });
    },
  });
  if (resolveSelfhostAutomationSchedulerEnabled(process.env)) {
    automationScheduler = new SelfhostAutomationScheduler({
      taskService: services.getOptional(IZCodeTaskService),
      modelSelectionService: services.getOptional(IModelSelectionService),
    });
    automationScheduler.start();
  }

  createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
