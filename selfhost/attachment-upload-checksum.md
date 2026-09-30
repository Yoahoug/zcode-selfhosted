# 附件上传校验和（SHA-256）

## 背景与问题

自建 Web 部署跑在明文 HTTP 上（例如 `http://10.66.66.66:3030`）时，浏览器把这个 origin 判定为非安全上下文，
`crypto.subtle` 不存在。`packages/ui/src/v4/attachmentUploadTransaction.ts` 的 `checksum()` 因此直接抛
`fault.attachment.checksumUnavailable`，而它发生在 `attachmentBegin` 之前，所以：

- Web 端所有附件（粘贴截图、文件选择器、拖拽）必然上传失败，缩略图停在红色 `!`；
- 服务端收不到任何 `attachmentBegin/Chunk/Commit`，运维侧没有任何日志可查（2026-09-30 线上实例实测）。

桌面端本地 workspace 走 `localPath` 零拷贝，不经过校验和计算，因此不受影响。

## 产品规则

1. 附件上传能力不依赖页面是否处于安全上下文；内网明文 HTTP 的自建部署是受支持场景。
2. 校验和算法与格式固定为 `sha256:<小写十六进制>`，必须与服务端
   `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/attachment-upload-registry.ts`
   中 `createHash("sha256").digest("hex")` 的比对结果一致。
3. 服务端仍是校验和的唯一裁决者：客户端算错或跳过，`commit` 必须失败（`fault.attachment.checksumMismatch`）。

## 所有者与接口

- 校验和计算所有者是新增的 `packages/ui/src/lib/sha256.ts`，对外只暴露
  `sha256Hex(bytes: Uint8Array): Promise<string>`：优先用 `globalThis.crypto?.subtle.digest("SHA-256", …)`，
  仅在 `crypto.subtle` 不可用时回退到同文件内的纯 JS 实现。它不承载协议与上传语义。
- 调用方 `attachmentUploadTransaction.checksum()` 只负责加 `sha256:` 前缀，并在走回退路径时记录一次告警，
  不再直接触碰 WebCrypto。
- 纯 JS 实现只依赖 `Uint8Array`/`DataView`，不引入第三方哈希库，也不做流式/增量接口。

```text
用户粘贴图片 → serializeChatComposerAttachment → put
  → uploadAttachmentTransaction
      │ checksum(bytes)
      ├ crypto.subtle 可用   → WebCrypto digest
      └ crypto.subtle 不可用 → 纯 JS SHA-256 + 一次 warn
      ▼
  attachmentBegin(checksum) → attachmentChunk* → attachmentCommit
```

## 不变式

- 同一字节序列在两条路径下必须产出完全相同的十六进制摘要，与服务端 `sha256:` 前缀格式逐字符可比较。
- 回退路径不改变协议帧、分片大小、字节数、超时与中止语义。
- 不静默跳过校验：摘要计算本身失败仍然让这次上传失败，不降级为"无校验上传"。
- 安全上下文下行为与改动前完全一致。

## 验收场景

1. 安全上下文：`sha256Hex` 走 WebCrypto，与 `node:crypto` 的 SHA-256 结果一致。
2. 非安全上下文（`crypto` 上没有 `subtle`）：`sha256Hex` 走纯 JS 实现，结果与场景 1 相同。
3. 纯 JS 实现在空输入、分组边界长度（55/56/63/64/65 字节）、含 0x00 与 0xff 的二进制、以及 ≥1MiB
   输入上与 `node:crypto` 一致。
4. 非安全上下文下每个页面会话只记录一次告警，且告警里带上页面 origin，便于发现部署问题。
   该条是诊断要求，靠评审与线上日志确认：ui logger 在模块加载时就捕获了 console 引用，
   单测无法稳定拦截这条输出，因此不写自动化断言。

## 迁移边界

- 不改 RPC 协议、不改 CLI 校验逻辑、不改桌面 localPath 零拷贝路径，也不改非安全上下文以外的行为。
- 已部署的非安全上下文实例无需迁移，升级前端产物后即可上传；安全上下文实例行为不变。
