# Selfhost 服务器部署（ops，宿主机直跑）

目标机器：`10.66.66.66`（Ubuntu 24.04，x86_64），不用 Docker，直接跑宿主机。

## 一键安装

以 root 在服务器上执行（幂等：同版本重装、新版本升级；token 与数据目录保留）：

```sh
ZCODE_DIST_BASE_URL="https://github.com/Yoahoug/zcode-selfhosted/releases/download/selfhost-v<VERSION>/" \
  bash /data/appdata/zcode-web/install.sh
```

脚本做五件事：检查 Node>=24 → 建 `zcode` 用户与 `/data/appdata/zcode-web/{workspace,data}` →
以 `zcode` 身份装发行包 → 写 systemd unit 并 `enable --now` → 轮询 `server-info` 确认就绪。

发布新版本后，把上面 URL 里的 tag 换成新 tag 再跑一遍，然后
`systemctl restart zcode-web` 即可。升级不碰数据目录，会话与配置自动保留。

## 运行时布局

| 项 | 值 |
|---|---|
| 运行用户 | `root`（2026-09-30 起按用户要求；此前为 `zcode`，发行包安装仍以 zcode 身份执行） |
| 发行包 | `/home/zcode/.zcode/runtime/releases/<版本>/`，`current` 软链指向生效版本 |
| workspace | `/data/appdata/zcode-web/workspace` |
| 数据目录 | `/data/appdata/zcode-web/data`（`ZCODE_DATA_BASE_DIR`，含会话 sqlite） |
| token | `/data/appdata/zcode-web/.web-token`（600）；systemd 经 `web.env` 以 `--token=${ZCODE_WEB_TOKEN}` 注入 |
| 服务 | `zcode-web.service`，`Restart=always`，开机自启 |
| 端口 | 3030，监听组网 IP `10.66.66.66` |
| 空闲释放 | 默认 30 分钟（`ZCODE_SELFHOST_IDLE_TIMEOUT_MINUTES`，0 关闭） |

访问：`http://10.66.66.66:3030/?token=<.web-token 内容>`。

## 运维命令

```sh
systemctl status zcode-web
journalctl -u zcode-web -f
TOKEN=$(cat /data/appdata/zcode-web/.web-token)
curl "http://10.66.66.66:3030/api/selfhost/resource?token=$TOKEN"  # 资源快照
systemctl restart zcode-web                                        # 重启
```

## 踩过的坑（不要重犯）

1. **systemd 不展开 shell 命令替换**：unit 里写 `--token $(cat ...)` 会把字面量
   当 token，导致全站 401。必须用 `EnvironmentFile` + `--token=${VAR}`。
2. **别用 127.0.0.1 做就绪检查**：`--host` 绑定组网 IP 时，服务只监听该 IP，
   `curl 127.0.0.1` 连 refused 不代表服务没起，用组网 IP 检查。
3. **GitHub Release 资产是扁平的**：上游 install.sh 按
   `${BASE_URL}/releases/$VERSION/$TARBALL` 拼 URL 会 404，打包工作流里已做
   扁平化改写（见 `.github/workflows/selfhost-release.yml`）。
4. **base-url 必须指向本次 tag**：指浮动的 `selfhost-latest` 会在重发时错位 404。
5. **Node>=24**：服务器预装是 v22，已用 nodesource 升到 v24。仓库 `mise.toml` 为准。
6. **明文 HTTP 会关掉一批安全上下文 API**：2026-09-30 线上实例上传图片必失败，根因不是图片本身，
   而是 `http://<组网 IP>` 不是安全上下文、浏览器不暴露 `crypto.subtle`，附件上传在算校验和时就抛错
   （服务端收不到任何请求，日志无痕）。UI 侧已回退到内置 SHA-256，见
   `selfhost/attachment-upload-checksum.md`；但 `navigator.clipboard` 同样不存在，
   上 TLS 前界面的复制按钮一律失效。
