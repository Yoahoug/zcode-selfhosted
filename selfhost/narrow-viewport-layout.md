# Web 窄视口（手机）布局 spec（自托管二开）

适用形态：`zcode --web` 自托管（`packages/web` + `packages/ui`）。
不新增组件树、不引入独立移动端 UI：手机访问与桌面共用同一 shell，
只在窄视口下改变侧栏的呈现方式与默认状态。

## 背景

仓库没有独立的移动端界面。手机远控链路复用同一 `WorkspaceShellLayout`，
只按平台裁剪个别按钮；自托管 web 用手机浏览器访问时就是桌面布局，
侧栏定宽（`--workspace-sidebar-panel-width`，约 264px）+ 对话区
`min-w-[320px]` 会把内容挤出 390px 视口，且无展开/收起入口。

## 行为

1. **判定**：`useIsNarrowViewport`（`packages/ui/src/hooks/useIsNarrowViewport.ts`）
   - 媒体查询 `(max-width: 767px)`，与 Tailwind `md:` 断点对齐，
     CSS 前缀与 JS 判定不会互相矛盾。
   - 只看视口宽度，不看 pointer/UA：手机横屏、桌面拖窄窗口走同一套布局。
   - `readIsNarrowViewport()` 同步读 + hook 订阅 `change`，SSR 安全
     （无 window 时恒为 false）。
2. **侧栏默认收起**：`useAppPanels` 初始 `isSidebarVisible` 在窄视口下为 false。
   桌面布局不变（初始展开）。
3. **抽屉化侧栏**（`WorkspaceShellLayout`，仅窄视口分支）：
   - 面板改为 `absolute inset-y-0 left-0 z-40 w-[min(320px,86vw)]` 叠加层，
     不参与 `ResizablePanelGroup` 分栏；收起点 `-translate-x-full`，
     展开点 `translate-x-0`，过渡 transform 不触发整树重排。
   - 展开时渲染背板 `absolute inset-0 z-30 bg-black/40`：压过 composer 等
     z-20 内容层保证手机可点，点背板收起。
   - 分栏拖拽 separator、对话区 `min-w-[320px]`、`max-w-[50%]` 仅限桌面分支。
   - 自动收起：窗口刚变窄（旋转/缩放）或 activeTaskId 变化（抽屉里点了
     另一个会话）时收起；桌面布局两个信号都不触发，不覆盖手动展开。
4. **展开入口**：`DesktopTopOverlay` 在窄视口且无自定义标题栏的平台
   （web 即此形态）也渲染侧栏开关按钮，等价 macOS 桌面分支；
   Windows/Linux 桌面自定义标题栏分支不变。

## 所有者与边界

- 断点唯一真相：`NARROW_VIEWPORT_MEDIA_QUERY`（useIsNarrowViewport.ts），
  其它窄视口分支一律 import 该常量或 hook，不得手写 767。
- `isSidebarVisible` 状态所有者仍是 `useAppPanels`；抽屉只是窄视口下同一
  状态的另一种呈现，不新增第二份显隐状态。
- 桌面（≥768px）渲染路径与改动前逐字节一致：不改 `ResizablePanelGroup`
  结构、不动 CSS 变量 split。

## 验收场景（390×844 / 844×390 / 1280×800 实测）

- 手机首屏：侧栏收起，对话区独占整屏；顶部有侧栏开关。
- 展开抽屉：320px 叠加层 + 背板；任务列表、资源卡片正常；点背板收起。
- 抽屉内点选任务：自动收起，会话视图可用（对话流/工具调用/composer）。
- 横屏：对话区 + composer 正常，无横向滚动。
- 桌面宽视口：定宽侧栏铺开，布局与改动前一致。
