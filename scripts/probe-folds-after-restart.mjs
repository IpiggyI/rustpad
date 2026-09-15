/**
 * Throwaway probe, not part of any suite: do single-document folds survive a
 * server restart on the same device?
 *
 * Reproduces the reported setup: persistence is on, the document and its
 * folds:<id> sidecar are written, the server process restarts, and the SAME
 * browser context - localStorage intact - opens the document again. The sidecar
 * must then be loaded back out of SQLite before any client decides what the
 * fold record is.
 *
 * Requires a backend started with SQLITE_URI whose command is given in
 * RESTART_CMD, plus the dev server at RUSTPAD_URL.
 */
import { execSync, spawn } from "node:child_process";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright-core"
);
const base = process.env.RUSTPAD_URL || "http://127.0.0.1:5173";
const sqliteUri = process.env.SQLITE_URI;
const serverBin = process.env.SERVER_BIN || "./target/debug/rustpad-server";
const rounds = Number(process.env.PROBE_ROUNDS || 5);

if (!sqliteUri) {
  console.error("SQLITE_URI must be set so the restart keeps the documents.");
  process.exit(1);
}

function stopServer() {
  try {
    execSync(`pkill -f "${serverBin}"`);
  } catch {
    // Already gone.
  }
}

async function startServer() {
  const child = spawn(serverBin, [], {
    env: { ...process.env, PORT: "3030", SQLITE_URI: sqliteUri },
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const response = await fetch("http://127.0.0.1:3030/api/stats");
      if (response.ok) {
        await response.body?.cancel();
        return;
      }
    } catch {
      // Not listening yet.
    }
  }
  throw new Error("backend did not come back up");
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox"],
});

const body = ["## One", "body one", "## Two", "body two"].join("\n");

async function openDoc(context, id) {
  const page = await context.newPage();
  await page.goto(`${base}/#${id}`);
  await page.waitForFunction(
    () => window.monaco && window.monaco.editor.getEditors().length > 0,
    undefined,
    { timeout: 30000 },
  );
  return page;
}

async function hiddenLines(page) {
  return page.evaluate(() => {
    const editor = window.monaco.editor.getEditors()[0];
    const ranges = editor._modelData?.viewModel?.getHiddenAreas?.() ?? [];
    let hidden = 0;
    for (const range of ranges) {
      hidden += range.endLineNumber - range.startLineNumber + 1;
    }
    return hidden;
  });
}

async function sidecarText(page, id) {
  return page.evaluate(
    (watched) =>
      new Promise((resolve) => {
        const uri = `${location.origin.replace(/^http/, "ws")}/api/socket/folds:${watched}`;
        const socket = new WebSocket(uri);
        let content = "";
        socket.onmessage = ({ data }) => {
          const msg = JSON.parse(data);
          if (msg.History === undefined) return;
          for (const { operation } of msg.History.operations) {
            let at = 0;
            let next = "";
            for (const part of operation) {
              if (typeof part === "string") next += part;
              else if (part >= 0) {
                next += content.slice(at, at + part);
                at += part;
              } else at -= part;
            }
            content = next;
          }
          socket.close();
          resolve(content);
        };
        setTimeout(() => {
          socket.close();
          resolve(content);
        }, 4000);
      }),
    id,
  );
}

let lost = 0;
try {
  for (let round = 1; round <= rounds; round++) {
    const docId = `restart${Date.now()}r${round}`;
    const context = await browser.newContext();

    const page = await openDoc(context, docId);
    await page.locator("select").first().selectOption("markdown");
    await page.waitForTimeout(400);
    await page.evaluate(
      (text) => window.monaco.editor.getEditors()[0].getModel().setValue(text),
      body,
    );
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      const editor = window.monaco.editor.getEditors()[0];
      editor.setPosition({ lineNumber: 1, column: 1 });
      editor.getAction("editor.fold").run();
    });
    await page.waitForTimeout(2500);
    const before = await hiddenLines(page);
    const sidecarBefore = await sidecarText(page, docId);
    await page.close();
    // Let the persister write; it runs every three to four seconds.
    await new Promise((resolve) => setTimeout(resolve, 6000));

    stopServer();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await startServer();

    // Same context, so localStorage still holds this device's fold record.
    const reopened = await openDoc(context, docId);
    await reopened.waitForTimeout(4000);
    const after = await hiddenLines(reopened);
    const sidecarAfter = await sidecarText(reopened, docId);
    await reopened.close();
    await context.close();

    const verdict = after === before ? "kept" : "LOST";
    if (after !== before) lost++;
    console.log(
      `round ${round}: hidden ${before} -> ${after} (${verdict}); sidecar before=${JSON.stringify(sidecarBefore).slice(0, 90)} after=${JSON.stringify(sidecarAfter).slice(0, 90)}`,
    );
  }
  console.log(`\nrounds=${rounds} lost=${lost}`);
  console.log(
    lost > 0
      ? "RESULT: REPRODUCED fold loss across a server restart"
      : "RESULT: folds survived every restart in this run",
  );
} finally {
  await browser.close();
}
