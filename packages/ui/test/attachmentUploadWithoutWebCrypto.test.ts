import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentPutResult,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeAgentAttachmentBeginParams,
  ZCodeAgentAttachmentChunkParams,
  ZCodeAgentAttachmentTerminalParams,
} from "@zcode/services";
import { uploadAttachmentTransaction } from "../src/v4/attachmentUploadTransaction.js";

const realCrypto = globalThis.crypto;
const WORKSPACE = { workspacePath: "/tmp/zcode-attachment-probe" };
const SESSION_ID = "session-attachment-probe";
/** 分片阈值是 384KiB，多给 10 字节确保跨片。 */
const MULTI_CHUNK_BYTES = 384 * 1024 + 10;

/**
 * 伪造内网明文 HTTP 下的非安全上下文：真实环境里 crypto 仍在、只缺 subtle，
 * 所以这里保留 getRandomValues，避免测出与线上不一致的行为。
 */
async function withoutWebCrypto<T>(run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) },
    writable: true,
  });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
  }
}

function patternBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 37 + 11) & 0xff;
  }
  return bytes;
}

function expectedChecksum(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function createRecordingAgent() {
  const begins: ZCodeAgentAttachmentBeginParams[] = [];
  const chunks: ZCodeAgentAttachmentChunkParams[] = [];
  const commits: ZCodeAgentAttachmentTerminalParams[] = [];
  const aborts: ZCodeAgentAttachmentTerminalParams[] = [];

  return {
    aborts,
    begins,
    chunks,
    commits,
    async attachmentBeginV4(
      params: ZCodeAgentAttachmentBeginParams,
    ): Promise<V4AttachmentBeginResult> {
      begins.push(params);
      return { state: "staging", uploadId: params.uploadId, nextChunkIndex: 0 };
    },
    async attachmentChunkV4(
      params: ZCodeAgentAttachmentChunkParams,
    ): Promise<V4AttachmentChunkResult> {
      chunks.push(params);
      return { uploadId: params.uploadId, nextChunkIndex: params.chunkIndex + 1 };
    },
    async attachmentCommitV4(
      params: ZCodeAgentAttachmentTerminalParams,
    ): Promise<V4AttachmentPutResult> {
      commits.push(params);
      return { ref: `zcode-artifact://${SESSION_ID}/artifact-probe` };
    },
    async attachmentAbortV4(params: ZCodeAgentAttachmentTerminalParams): Promise<void> {
      aborts.push(params);
    },
  };
}

function buildInput(bytes: Uint8Array, fileName: string) {
  return {
    sessionId: SESSION_ID,
    fileName,
    mime: "image/png",
    dataBase64: Buffer.from(bytes).toString("base64"),
  };
}

test("upload completes without crypto.subtle and carries the node-verifiable checksum", async () => {
  const bytes = patternBytes(4096);
  const agent = createRecordingAgent();

  const result = await withoutWebCrypto(() =>
    uploadAttachmentTransaction(agent, WORKSPACE, buildInput(bytes, "probe.png")),
  );

  assert.equal(result.ref, `zcode-artifact://${SESSION_ID}/artifact-probe`);
  assert.equal(agent.begins.length, 1);
  assert.equal(agent.begins[0]?.checksum, expectedChecksum(bytes));
  assert.equal(agent.begins[0]?.totalBytes, bytes.byteLength);
  assert.deepEqual(agent.aborts, []);
  assert.deepEqual(agent.commits, [
    {
      sessionId: SESSION_ID,
      uploadId: agent.begins[0]?.uploadId,
      workspacePath: WORKSPACE.workspacePath,
    },
  ]);
});

test("multi-chunk upload without crypto.subtle reassembles the original bytes", async () => {
  const bytes = patternBytes(MULTI_CHUNK_BYTES);
  const agent = createRecordingAgent();

  await withoutWebCrypto(() =>
    uploadAttachmentTransaction(agent, WORKSPACE, buildInput(bytes, "probe-large.png")),
  );

  assert.equal(agent.begins[0]?.totalChunks, 2);
  assert.equal(agent.begins[0]?.checksum, expectedChecksum(bytes));
  assert.equal(agent.chunks.length, 2);
  const reassembled = Buffer.concat(
    agent.chunks.map((chunk) => Buffer.from(chunk.dataBase64, "base64")),
  );
  assert.equal(reassembled.byteLength, bytes.byteLength);
  assert.deepEqual(new Uint8Array(reassembled), bytes);
});

test("both checksum paths agree for the same attachment", async () => {
  const bytes = patternBytes(2048);
  const secureAgent = createRecordingAgent();
  const insecureAgent = createRecordingAgent();

  await uploadAttachmentTransaction(secureAgent, WORKSPACE, buildInput(bytes, "probe.png"));
  await withoutWebCrypto(() =>
    uploadAttachmentTransaction(insecureAgent, WORKSPACE, buildInput(bytes, "probe.png")),
  );

  assert.equal(insecureAgent.begins[0]?.checksum, secureAgent.begins[0]?.checksum);
  assert.equal(secureAgent.begins[0]?.checksum, expectedChecksum(bytes));
});
