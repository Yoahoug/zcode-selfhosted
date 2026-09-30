# Selfhost 版本迭代约束

## 初始版本

- `3.14.3-selfhost.1`（tag `selfhost-v3.14.3-selfhost.1`），基于上游 `zai-org/ZCode@29628c9`（v3.14.3）。
- 包含：空闲释放 Agent 内存 + sidebar 资源卡片（见 `selfhost/idle-resource.md`）、
  GitHub Actions 打包发行工作流（`.github/workflows/selfhost-release.yml`）。

## 版本号规则

- 格式：`<上游版本>-selfhost.<N>`，例如 `3.14.3-selfhost.1`。
- 上游升级时：先把上游版本号带过来，`N` 从 1 重新开始（`3.15.0-selfhost.1`）。
- 同一上游版本上的自托管修复：只递增 `N`（`3.14.3-selfhost.1` → `3.14.3-selfhost.2`）。
- 禁止复用已发布过的版本号；禁止移动已发布的 tag（本次 `selfhost-v3.14.3-selfhost.1`
  在修复发行 404 时被迫移动过一次，以后不再允许——有问题就发新版本）。

## 发布流程（每次必走）

1. 功能分支开发（`selfhost/*`），本地 `pnpm typecheck && pnpm lint` 通过，
   新增行为先写 `selfhost/*.md` 的 spec。
2. 合并到 `main`（fork 的 main 只收自托管改动，不直接合上游）。
3. 打 tag `selfhost-v<版本>` 并推送，Actions 自动完成检查 + 打包 + 发 Release。
4. 服务器升级：重跑一键安装脚本（幂等，同版本重装、新版本升级），再
   `systemctl restart zcode-web`。数据目录 `/data/appdata/zcode-web/data` 不动，
   会话与配置自动保留。
5. 验证：`curl "http://10.66.66.66:3030/api/server-info?token=$TOKEN"` 返回 200，
   且 `version` 字段与预期一致；浏览器打开带 token 链接确认页面与资源卡片正常。

## 上游同步约束

- 同步上游前先在本地开分支 `sync/upstream-<上游版本>`，解决冲突后完整跑一遍
  typecheck + lint + 发行包冒烟（`curl /api/selfhost/resource`）。
- 自托管二开全部收敛在以下位置，与上游文件不混写，冲突面最小：
  - `packages/server/src/selfhostIdleResource.ts`（新建）
  - `packages/server/src/http.ts`（仅接线：计数器、端点、WS 开关通知、Controller 通道注册）
  - `packages/server/src/selfhostTaskListController.ts`（新建）与 `packages/server/test/selfhostTaskListController.test.ts`（新建）
  - `packages/ui/src/WorkspaceArchivedTasksFlatSection.tsx`（归档查询对齐本地 scope）
  - `packages/ui/src/hooks/useSelfhostResource.tsx`（新建）
  - `packages/ui/src/WorkspaceSidebarFooterSelfhostResource.tsx`（新建）
  - `packages/ui/src/WorkspaceSidebarFooter.tsx`（仅挂载一行）与中英 i18n 增量 key
  - `selfhost/*.md`、`.github/workflows/selfhost-release.yml`（新建）
- 上游改动了 `http.ts` 或 `WorkspaceSidebarFooter.tsx` 时，同步后重点回归这两处接线。

## 服务器侧约束

- 运行用户固定为 `root`（2026-09-30 应用户要求从 `zcode` 切换：web 会话内需要执行
  git 推送、docker 等运维操作，zcode 用户无 sudo 无法完成。服务仅监听组网 IP
  `10.66.66.66`，不公网暴露，root 直跑风险可接受）。
- token 只存 `/data/appdata/zcode-web/web.env`（600 权限），禁止写进仓库、history、日志。
- systemd unit 里 token 通过 `--token=${ZCODE_WEB_TOKEN}` 传递（EnvironmentFile 注入），
  禁止 `$(cat ...)` 命令替换写法（systemd 不展开 shell 语法，会导致鉴权失效）。
- 监听地址固定为组网 IP（`--host 10.66.66.66`）；公网暴露前必须先上 TLS 反代。
- 空闲释放默认 30 分钟；需要常驻 Agent 时设 `ZCODE_SELFHOST_IDLE_TIMEOUT_MINUTES=0`。
