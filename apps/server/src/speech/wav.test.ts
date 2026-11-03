import { assert, it } from "@effect/vitest";
import { encodeWav } from "./wav.ts";

it("encodes a mono 16-bit PCM header and clamps samples", () => {
  const view = new DataView(encodeWav(new Float32Array([0, 2, -2]), 24_000).buffer);
  const ascii = (offset: number) =>
    String.fromCharCode(...[0, 1, 2, 3].map((index) => view.getUint8(offset + index)));
  assert.deepStrictEqual(
    [ascii(0), ascii(8), ascii(12), ascii(36)],
    ["RIFF", "WAVE", "fmt ", "data"],
  );
  assert.strictEqual(view.getUint32(4, true), 36 + 6);
  assert.strictEqual(view.getUint16(22, true), 1);
  assert.strictEqual(view.getUint32(24, true), 24_000);
  assert.strictEqual(view.getUint16(34, true), 16);
  assert.strictEqual(view.getUint32(40, true), 6);
  assert.deepStrictEqual(
    [0, 1, 2].map((index) => view.getInt16(44 + index * 2, true)),
    [0, 32767, -32768],
  );
});
