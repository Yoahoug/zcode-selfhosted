import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sha256Hex } from "../src/lib/sha256.js";

const realCrypto = globalThis.crypto;

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

function referenceHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function patternBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = (index * 31 + seed * 17) & 0xff;
  }
  return bytes;
}

/** 覆盖 padding 前后（55/56/63/64/65）与大输入的整块边界。 */
const BOUNDARY_LENGTHS = [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 1024 * 1024 + 7];

test("published SHA-256 vectors match on both digest paths", async () => {
  const empty = new Uint8Array(0);
  const abc = new TextEncoder().encode("abc");
  const emptyHex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const abcHex = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

  assert.equal(await sha256Hex(empty), emptyHex);
  assert.equal(await sha256Hex(abc), abcHex);
  await withoutWebCrypto(async () => {
    assert.equal(await sha256Hex(empty), emptyHex);
    assert.equal(await sha256Hex(abc), abcHex);
  });
});

test("built-in digest matches node:crypto across padding boundaries and large inputs", async () => {
  await withoutWebCrypto(async () => {
    for (const length of BOUNDARY_LENGTHS) {
      const bytes = patternBytes(length, length % 13);
      assert.equal(await sha256Hex(bytes), referenceHex(bytes), `length=${length}`);
    }
  });
});

test("built-in digest matches the WebCrypto path for the same bytes", async () => {
  const bytes = patternBytes(4096, 5);
  const withSubtle = await sha256Hex(bytes);
  const withoutSubtle = await withoutWebCrypto(() => sha256Hex(bytes));
  assert.equal(withoutSubtle, withSubtle);
});

test("binary payloads containing 0x00 and 0xff are hashed byte for byte", async () => {
  const bytes = new Uint8Array(300);
  bytes.fill(0xff, 0, 150);
  bytes[200] = 0x00;

  assert.equal(await sha256Hex(bytes), referenceHex(bytes));
  assert.equal(await withoutWebCrypto(() => sha256Hex(bytes)), referenceHex(bytes));
});

test("repeated fallback calls do not leak work state between digests", async () => {
  await withoutWebCrypto(async () => {
    const first = patternBytes(777, 1);
    const second = patternBytes(777, 2);

    assert.equal(await sha256Hex(first), referenceHex(first));
    assert.equal(await sha256Hex(second), referenceHex(second));
    assert.equal(await sha256Hex(first), referenceHex(first));
  });
});
