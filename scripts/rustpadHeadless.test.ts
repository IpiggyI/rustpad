import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { OpSeq } from "rustpad-wasm";

register(new URL("./register-ts-resolve.mjs", import.meta.url));

const { default: RustpadHeadless } = await import("../src/rustpad-headless.ts");

function applySentEdits(start: string, sent: string[]): string {
  let content = start;
  for (const raw of sent) {
    const parsed = JSON.parse(raw);
    if (!parsed.Edit) continue;
    const op = OpSeq.from_str(JSON.stringify(parsed.Edit.operation));
    assert.ok(op, "edit payload must deserialize");
    const next = op.apply(content);
    assert.equal(typeof next, "string");
    content = next;
  }
  return content;
}

test("second replaceContent then dispose still sends the latest content", async () => {
  const previousWindow = globalThis.window;
  const previousWebSocket = globalThis.WebSocket;
  const sent = [];

  class MockWebSocket {
    onopen = null;
    onclose = null;
    onmessage = null;
    constructor(uri) {
      this.uri = uri;
      queueMicrotask(() => this.onopen?.());
    }
    send(data) {
      sent.push(data);
    }
    close() {
      this.onclose?.();
    }
  }

  globalThis.WebSocket = MockWebSocket;
  globalThis.window = globalThis;

  try {
    let connected = false;
    const headless = new RustpadHeadless({
      uri: "ws://folds-test",
      reconnectInterval: 60_000,
      onConnected: () => {
        connected = true;
      },
    });
    const started = Date.now();
    while (!connected && Date.now() - started < 1000) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(connected, true);

    headless.replaceContent("first");
    headless.replaceContent("second");
    await headless.dispose();

    assert.equal(applySentEdits("", sent), "second");
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
    if (previousWebSocket === undefined) {
      delete globalThis.WebSocket;
    } else {
      globalThis.WebSocket = previousWebSocket;
    }
  }
});
