/**
 * Prerequisites for `npm run test:browser`:
 * - Start the dev server with `npm run dev`.
 * - Start the backend with `PORT=3030 cargo run -p rustpad-server`.
 * - Install Chromium, or set CHROMIUM_PATH to an existing executable.
 */
import assert from "node:assert/strict";

const base = process.env.RUSTPAD_URL || "http://127.0.0.1:5173";

try {
  const response = await fetch(base, { signal: AbortSignal.timeout(5000) });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  console.error(
    `Cannot reach ${base}. Start the dev server or set RUSTPAD_URL.`,
    error,
  );
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import(
    process.env.PLAYWRIGHT_MODULE || "playwright-core"
  ));
} catch (error) {
  console.error("Cannot load Playwright.", error);
  process.exit(1);
}

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
    args: ["--no-sandbox"],
  });
} catch (error) {
  console.error("Cannot launch Chromium.", error);
  process.exit(1);
}

function wsUrl(docId) {
  const url = new URL(`api/socket/${docId}`, base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

async function fetchText(docId) {
  const response = await fetch(new URL(`api/text/${docId}`, base));
  assert.equal(
    response.ok,
    true,
    `text request failed with ${response.status}`,
  );
  return response.text();
}

async function openPeer(docId) {
  const socket = new WebSocket(wsUrl(docId));
  let receivedOperations = 0;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("peer did not receive initial History")),
      5000,
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.History === undefined) return;
      receivedOperations = Math.max(
        receivedOperations,
        message.History.start + message.History.operations.length,
      );
      clearTimeout(timeout);
      resolve();
    });
    socket.addEventListener("error", reject);
  });
  return {
    socket,
    receivedOperations: () => receivedOperations,
  };
}

async function waitForPeerOperations(peer, expected) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (peer.receivedOperations() >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(
    `peer received ${peer.receivedOperations()} operations; expected ${expected}`,
  );
}

async function createHarness(page, docId) {
  return page.evaluate(
    async ({ uri, modelPath }) => {
      const NativeWebSocket =
        globalThis.__nativeRustpadWebSocket || window.WebSocket;
      globalThis.__nativeRustpadWebSocket = NativeWebSocket;

      class ControlledWebSocket {
        static CONNECTING = NativeWebSocket.CONNECTING;
        static OPEN = NativeWebSocket.OPEN;
        static CLOSING = NativeWebSocket.CLOSING;
        static CLOSED = NativeWebSocket.CLOSED;

        constructor(url, protocols) {
          this.onopen = null;
          this.onclose = null;
          this.onerror = null;
          this.onmessage = null;
          this.holdMessages = false;
          this.messages = [];
          this.closeCalls = 0;
          this.inner = protocols
            ? new NativeWebSocket(url, protocols)
            : new NativeWebSocket(url);
          this.inner.addEventListener("open", (event) => this.onopen?.(event));
          this.inner.addEventListener("close", (event) =>
            this.onclose?.(event),
          );
          this.inner.addEventListener("error", (event) =>
            this.onerror?.(event),
          );
          this.inner.addEventListener("message", (event) => {
            if (this.holdMessages) {
              this.messages.push(event);
            } else {
              this.onmessage?.(event);
            }
          });
          globalThis.__lastControlledSocket = this;
        }

        get readyState() {
          return this.inner.readyState;
        }

        get bufferedAmount() {
          return this.inner.bufferedAmount;
        }

        send(data) {
          this.inner.send(data);
        }

        close(code, reason) {
          this.closeCalls += 1;
          this.inner.close(code, reason);
        }

        drop() {
          this.inner.close();
        }

        releaseNextHistory() {
          const index = this.messages.findIndex((event) => {
            const message = JSON.parse(String(event.data));
            return message.History !== undefined;
          });
          if (index < 0) return false;
          const [event] = this.messages.splice(index, 1);
          this.onmessage?.(event);
          return true;
        }

        historyCount() {
          return this.messages.filter((event) => {
            const message = JSON.parse(String(event.data));
            return message.History !== undefined;
          }).length;
        }
      }

      window.WebSocket = ControlledWebSocket;
      const host = document.createElement("div");
      host.style.width = "400px";
      host.style.height = "200px";
      document.body.append(host);
      const model = window.monaco.editor.createModel(
        "",
        "plaintext",
        window.monaco.Uri.parse(`file:///${modelPath}`),
      );
      const editor = window.monaco.editor.create(host, { model });
      const { default: Rustpad } = await import("/src/rustpad.ts");

      let readyResolve;
      const readyPromise = new Promise((resolve) => {
        readyResolve = resolve;
      });
      const client = new Rustpad({
        uri,
        editor,
        onReady: readyResolve,
        onDesynchronized: () => {
          globalThis.__closeHarness.desynchronized = true;
        },
      });
      let initialSync = "pending";
      const initialSyncPromise = client.waitForSync().then(
        () => {
          initialSync = "resolved";
        },
        (error) => {
          initialSync = `rejected: ${error.message}`;
        },
      );
      assertHarness(initialSync === "pending", "sync resolved before History");
      await readyPromise;
      await initialSyncPromise;
      assertHarness(
        initialSync === "resolved",
        "sync did not wait for History",
      );

      const socket = globalThis.__lastControlledSocket;
      socket.holdMessages = true;
      globalThis.__closeHarness = {
        client,
        editor,
        host,
        model,
        socket,
        syncState: "idle",
        disposeState: "idle",
        disposeError: "",
        desynchronized: false,
      };

      function assertHarness(condition, message) {
        if (!condition) throw new Error(message);
      }
    },
    { uri: wsUrl(docId), modelPath: `close-${docId}` },
  );
}

async function waitForHeldHistory(page) {
  await page.waitForFunction(
    () => globalThis.__closeHarness.socket.historyCount() > 0,
  );
}

async function state(page) {
  return page.evaluate(() => {
    const harness = globalThis.__closeHarness;
    return {
      closeCalls: harness.socket.closeCalls,
      syncState: harness.syncState,
      disposeState: harness.disposeState,
      disposeError: harness.disposeError,
    };
  });
}

async function checkTransientCopy(context) {
  const page = await context.newPage();
  const sockets = [];
  let holdEdits = false;
  let heldEdits = 0;
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.routeWebSocket(/\/api\/socket\/.*:block:/, (route) => {
    const server = route.connectToServer();
    sockets.push({ route, server });
    route.onMessage((message) => {
      if (holdEdits && JSON.parse(String(message)).Edit !== undefined) {
        heldEdits += 1;
        return;
      }
      server.send(message);
    });
  });
  await page.goto(`${base}/#page:copy-recovery-${Date.now()}`);
  await page.getByText("(1 block)", { exact: true }).waitFor();
  await page.waitForFunction(
    () => window.monaco?.editor.getEditors().length === 1,
  );
  await page.evaluate(async () => {
    const moduleUrl = performance
      .getEntriesByType("resource")
      .find((entry) => new URL(entry.name).pathname === "/src/rustpad.ts").name;
    const { default: Rustpad } = await import(moduleUrl);
    window.__copyResults = [];
    window.__closeResults = [];
    const waitForSync = Rustpad.prototype.waitForSync;
    Rustpad.prototype.waitForSync = function () {
      const result = { status: "pending" };
      window.__copyResults.push(result);
      return waitForSync.call(this).then(
        () => {
          result.status = "resolved";
        },
        (error) => {
          result.status = error.message;
          throw error;
        },
      );
    };
    const dispose = Rustpad.prototype.dispose;
    Rustpad.prototype.dispose = function () {
      const result = { status: "pending" };
      window.__closeResults.push(result);
      return dispose.call(this).then(
        () => {
          result.status = "resolved";
        },
        (error) => {
          result.status = error.message;
          throw error;
        },
      );
    };
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(base).origin,
  });
  await page.evaluate(() => navigator.clipboard.writeText("recovery-sentinel"));
  holdEdits = true;
  await page.locator("[data-block-panel] .monaco-editor").click();
  await page.keyboard.type("recovered edit");
  const copy = page.getByLabel("Copy block content");
  await copy.click();
  await page.waitForFunction(() => window.__copyResults.length === 1);
  assert.equal(
    heldEdits,
    1,
    "one outstanding edit must be awaiting acknowledgement",
  );
  assert.equal(
    await page.evaluate(() => window.__copyResults[0].status),
    "pending",
  );
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "recovery-sentinel",
  );
  // Drop the unsent edit so reconnect can resend it once to the real server.
  holdEdits = false;
  sockets[0].server.close();
  sockets[0].route.close();
  await page.getByText("Copy failed", { exact: true }).waitFor();
  await page
    .getByText("Copy failed", { exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(sockets.length, 2, "exactly one reconnect must occur");
  const blockId = await page
    .locator("[data-block-panel]")
    .getAttribute("data-block-panel");
  const pageId = await page.evaluate(() =>
    location.hash.slice("#page:".length),
  );
  assert.equal(
    await fetchText(`page:${pageId}:block:${blockId}`),
    "recovered edit",
  );
  await copy.click();
  await page.waitForFunction(
    () => window.__copyResults.at(-1).status !== "pending",
  );
  assert.equal(
    await page.evaluate(() => window.__copyResults.at(-1).status),
    "resolved",
    "a fresh copy after reconnect must not inherit the earlier failure",
  );
  await page.waitForFunction(
    async () => (await navigator.clipboard.readText()) === "recovered edit",
  );
  await page.getByText("Copied!", { exact: true }).waitFor({ state: "hidden" });
  const downloadPromise = page.waitForEvent("download");
  await page.getByLabel("Export block", { exact: true }).click();
  const stream = await (await downloadPromise).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString("utf8"), "recovered edit");
  await page
    .getByRole("button", { name: "Back to Document", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      window.__closeResults.length > 0 &&
      window.__closeResults.every((result) => result.status !== "pending"),
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.__closeResults.map((result) => result.status),
    ),
    ["resolved"],
  );
  assert.equal(
    await page.getByText("Block sync failed", { exact: true }).count(),
    0,
  );
  assert.equal(
    errors.some((error) => error.includes("Failed to close block connection")),
    false,
  );
  console.log(
    "PASS recovery: one disconnect rejects in-flight copy; fresh copy/export and clean unmount succeed",
  );
  await page.close();
}

try {
  const context = await browser.newContext();
  await checkTransientCopy(context);
  const page = await context.newPage();
  await page.goto(`${base}/#close-harness-${Date.now()}`);
  await page.waitForFunction(() => window.monaco?.editor);

  const drainDoc = `close-drain-${Date.now()}`;
  const peer = await openPeer(drainDoc);
  await createHarness(page, drainDoc);
  await page.evaluate(() => {
    const harness = globalThis.__closeHarness;
    harness.model.setValue("first");
    harness.model.setValue("first-second");
    harness.syncState = "pending";
    harness.client.waitForSync().then(
      () => {
        harness.syncState = "resolved";
      },
      (error) => {
        harness.syncState = `rejected: ${error.message}`;
      },
    );
    harness.disposeState = "pending";
    harness.client.dispose().then(
      () => {
        harness.disposeState = "resolved";
      },
      (error) => {
        harness.disposeState = "rejected";
        harness.disposeError = error.message;
      },
    );
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);
    globalThis.__beforeUnloadPrevented = beforeUnload.defaultPrevented;
    harness.editor.dispose();
    harness.model.dispose();
    harness.host.remove();
  });
  await waitForHeldHistory(page);
  assert.deepEqual(await state(page), {
    closeCalls: 0,
    syncState: "pending",
    disposeState: "pending",
    disposeError: "",
  });
  assert.equal(await page.evaluate(() => __beforeUnloadPrevented), true);

  assert.equal(
    await page.evaluate(() =>
      globalThis.__closeHarness.socket.releaseNextHistory(),
    ),
    true,
  );
  await waitForHeldHistory(page);
  assert.equal((await state(page)).closeCalls, 0);
  assert.equal((await state(page)).disposeState, "pending");
  assert.equal(
    await page.evaluate(() =>
      globalThis.__closeHarness.socket.releaseNextHistory(),
    ),
    true,
  );
  await page.waitForFunction(
    () => globalThis.__closeHarness.disposeState !== "pending",
  );
  assert.deepEqual(await state(page), {
    closeCalls: 1,
    syncState: "resolved",
    disposeState: "resolved",
    disposeError: "",
  });
  await waitForPeerOperations(peer, 2);
  assert.equal(await fetchText(drainDoc), "first-second");
  peer.socket.close();
  console.log(
    "PASS drain: peer received outstanding and buffer before close after model teardown",
  );

  const dropDoc = `close-drop-${Date.now()}`;
  await createHarness(page, dropDoc);
  await page.evaluate(() => {
    const harness = globalThis.__closeHarness;
    harness.model.setValue("drop-before-ack");
    harness.disposeState = "pending";
    harness.client.dispose().then(
      () => {
        harness.disposeState = "resolved";
      },
      (error) => {
        harness.disposeState = "rejected";
        harness.disposeError = error.message;
      },
    );
  });
  await waitForHeldHistory(page);
  await page.evaluate(() => globalThis.__closeHarness.socket.drop());
  await page.waitForFunction(
    () => globalThis.__closeHarness.disposeState !== "pending",
  );
  assert.equal((await state(page)).disposeState, "rejected");
  assert.match((await state(page)).disposeError, /closed before.*acknowledged/);
  assert.match(
    (await state(page)).disposeError,
    /Copy any unsaved editor text manually, then reload the page/,
  );
  console.log("PASS disconnect: close before ACK rejects instead of resending");
  assert.match(
    await page.evaluate(() =>
      globalThis.__closeHarness.client.waitForSync().then(
        () => "resolved",
        (error) => error.message,
      ),
    ),
    /closed before.*acknowledged/,
  );

  await createHarness(page, `close-terminal-${Date.now()}`);
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.evaluate(() => globalThis.__closeHarness.socket.drop());
    if (attempt < 4) {
      await page.waitForFunction(
        () =>
          globalThis.__lastControlledSocket !==
            globalThis.__closeHarness.socket &&
          globalThis.__lastControlledSocket.readyState === WebSocket.OPEN,
      );
      await page.evaluate(() => {
        globalThis.__closeHarness.socket = globalThis.__lastControlledSocket;
      });
    }
  }
  await page.waitForFunction(() => globalThis.__closeHarness.desynchronized);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.match(
      await page.evaluate(() =>
        globalThis.__closeHarness.client.waitForSync().then(
          () => "resolved",
          (error) => error.message,
        ),
      ),
      /repeatedly disconnected/,
    );
  }
  assert.match(
    await page.evaluate(() =>
      globalThis.__closeHarness.client.dispose().then(
        () => "resolved",
        (error) => error.message,
      ),
    ),
    /repeatedly disconnected/,
  );
  console.log(
    "PASS terminal: five disconnects latch failure for later sync and dispose calls",
  );

  const timeoutDoc = `close-timeout-${Date.now()}`;
  await createHarness(page, timeoutDoc);
  await page.evaluate(() => {
    const harness = globalThis.__closeHarness;
    harness.model.setValue("never-release-ack");
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = (handler, delay, ...args) =>
      nativeSetTimeout(handler, delay === 10_000 ? 50 : delay, ...args);
    harness.disposeState = "pending";
    harness.client.dispose().then(
      () => {
        harness.disposeState = "resolved";
      },
      (error) => {
        harness.disposeState = "rejected";
        harness.disposeError = error.message;
      },
    );
  });
  await waitForHeldHistory(page);
  await page.waitForFunction(
    () => globalThis.__closeHarness.disposeState !== "pending",
  );
  assert.equal((await state(page)).disposeState, "rejected");
  assert.match((await state(page)).disposeError, /Timed out/);
  assert.equal((await state(page)).closeCalls, 1);
  console.log("PASS timeout: send without ACK rejects and closes the socket");

  await context.close();
} finally {
  await browser.close();
}
