import { describe, expect, it } from "vitest";
import { exampleGenUiPrepare } from "./contract.example.js";
import { IGenUiService } from "./contract.js";

// gen-ui-service 是受管模块，架构检查要求 contract.example 能真实绑定 contract 端口。
// 参考 plugin-ui-bridge/storage 同类 contract.test：只断言描述符与示例参数的形状，
// 不拉起真实服务（prepareSandbox 依赖桌面 WebContents，单测环境不覆盖）。
describe("gen-ui contract", () => {
  it("描述符以 gen-ui 频道名标识服务", () => {
    expect(IGenUiService.channelName).toBe("gen-ui");
  });

  it("示例 prepare 参数满足 contract 必填字段", () => {
    expect(exampleGenUiPrepare.workspacePath).toBe("/workspace");
    expect(typeof exampleGenUiPrepare.html).toBe("string");
    expect(typeof exampleGenUiPrepare.ownerWebContentsId).toBe("number");
    expect(typeof exampleGenUiPrepare.instanceKey).toBe("string");
  });
});
