# Selfhost ops 一键安装脚本 spec（自托管二开）

适用形态：ops 服务器（`10.66.66.66`，Ubuntu 24.04，宿主机直跑，不用 Docker）。
本 spec 只收敛服务器上 `/data/appdata/zcode-web/install.sh` 的既定行为，
仓库内不新增安装器实现；上游 `scripts/zcode-distribution/installer.mjs`
（用户级 `~/.zcode/runtime` 安装）保持不动。

## 行为

1. **幂等**：同版本重装、新版本升级；token（`.web-token`/`web.env`）与数据目录
   （`data/`，含会话 sqlite）保留，不存在时才生成。
2. **五步**：检查 Node>=24（`mise.toml` 为准）→ 建 `zcode` 用户与
   `/data/appdata/zcode-web/{workspace,data}` → 以 `zcode` 身份装发行包
   （`BASE_URL` 指向本次 tag 的 GitHub Release 扁平资产）→ 写 systemd unit 并
   `enable --now` → 轮询 `server-info` 确认就绪。
3. **token 双文件**：`.web-token`（纯 token，供就绪检查与用户访问链接）与
   `web.env`（`ZCODE_WEB_TOKEN=<token>`，供 systemd `EnvironmentFile` 注入），
   均为 600 权限、`zcode:zcode` 属主。`.web-token` 缺失时生成新 token 并同步
   `web.env`；`web.env` 缺失时从 `.web-token` 重建。两个文件内容不一致时以
   `.web-token` 为准重建 `web.env`。
4. **systemd unit**（`/etc/systemd/system/zcode-web.service`）：
   - `User=zcode`（禁止 root 直跑 web 进程）；
   - `Environment=ZCODE_DATA_BASE_DIR=/data/appdata/zcode-web/data`；
   - `Environment=ZCODE_SELFHOST_IDLE_TIMEOUT_MINUTES=30`（固定值，不从安装环境继承）；
   - `EnvironmentFile=/data/appdata/zcode-web/web.env` +
     `--token=${ZCODE_WEB_TOKEN}`（禁止 `$(cat …)` 命令替换写法，systemd 不展开）；
   - `--host 10.66.66.66 --port 3030 --workspace /data/appdata/zcode-web/workspace --no-open`；
   - `Restart=always` + `RestartSec=3`，开机自启。
5. **就绪检查**：用组网 IP（`http://10.66.66.66:$PORT/api/server-info?token=…`），
   禁止用 `127.0.0.1`（服务只监听组网 IP，`127.0.0.1` refused 不代表没起）。

## 所有者与事件顺序

- 唯一所有者：服务器上的 `install.sh`（运维产物，不进仓库；本 spec 是其行为契约）。
- 事件顺序：下载发行包 → 切 `current` 软链 → 写 unit → `daemon-reload` →
  `enable --now` → 就绪轮询。升级时数据目录不动，会话与配置自动保留。

## 不变量与失败语义

- 发行包布局：`/home/zcode/.zcode/runtime/releases/<版本>/`，`current` 软链指向生效版本。
- Release 资产是扁平的（无 `releases/<version>/` 目录层级），下载 URL 按
  `${BASE_URL%/}/$TARBALL` 拼接（见 `.github/workflows/selfhost-release.yml` 扁平化改写）。
- `BASE_URL` 必须指向本次 tag（`.../releases/download/selfhost-v<版本>/`），
  禁止指向浮动的 `selfhost-latest`。
- 60s 内未就绪则退出非零并提示看 `journalctl -u zcode-web`。

## 迁移边界

- 本 spec 不改变上游用户级安装行为；ops 脚本独立演进，只通过本文档与
  `selfhost/ops-deploy.md` 约束。
- 服务器侧约束（运行用户、token 路径与权限、组网 IP、TLS 前置）见
  `selfhost/versioning.md`「服务器侧约束」，不重复。
