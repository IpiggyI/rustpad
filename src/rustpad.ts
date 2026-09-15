import debounce from "lodash.debounce";
import type {
  IDisposable,
  IPosition,
  editor,
} from "monaco-editor/esm/vs/editor/editor.api";
import { OpSeq } from "rustpad-wasm";

import { type FoldingImeHold, attachFoldingImeHold } from "./markdownFolding";
import { diffText } from "./textDiff";

const SYNC_TIMEOUT_MS = 10_000;

type SyncWaiter = {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timeoutId: number;
  readonly requireReady: boolean;
};

const stoppedEditorOptions = new WeakMap<
  editor.IStandaloneCodeEditor,
  { readOnly: boolean; domReadOnly: boolean }
>();

/** Options passed in to the Rustpad constructor. */
export type RustpadOptions = {
  readonly uri: string;
  readonly editor: editor.IStandaloneCodeEditor;
  readonly onConnected?: () => void;
  readonly onReady?: () => void;
  readonly onDisconnected?: () => void;
  readonly onDesynchronized?: () => void;
  readonly onChangeLanguage?: (language: string) => void;
  readonly onChangeTitle?: (title: string) => void;
  readonly onChangeUsers?: (users: Record<number, UserInfo>) => void;
  readonly reconnectInterval?: number;
};

/** A user currently editing the document. */
export type UserInfo = {
  readonly name: string;
  readonly hue: number;
};

/** Browser client for Rustpad. */
class Rustpad {
  private ws?: WebSocket;
  private connecting?: boolean;
  private recentFailures: number = 0;
  private readonly model: editor.ITextModel;
  private readonly onChangeHandle: IDisposable;
  private readonly onCursorHandle: IDisposable;
  private readonly onSelectionHandle: IDisposable;
  private readonly onCompositionStartHandle: IDisposable;
  private readonly onCompositionEndHandle: IDisposable;
  private readonly foldingImeHold: FoldingImeHold;
  private readonly beforeUnload: (event: BeforeUnloadEvent) => void;
  private readonly tryConnectId: number;
  private readonly resetFailuresId: number;
  private connectingSocket?: WebSocket;
  private stopping: boolean = false;
  private disposed: boolean = false;
  private disposePromise?: Promise<void>;
  private syncFailure?: Error;
  private readonly syncWaiters = new Set<SyncWaiter>();

  // Client-server state
  private me: number = -1;
  private revision: number = 0;
  private outstanding?: OpSeq;
  private buffer?: OpSeq;
  private ready: boolean = false;
  private users: Record<number, UserInfo> = {};
  private userCursors: Record<number, CursorData> = {};
  private myInfo?: UserInfo;
  private pendingTitle?: string;
  private cursorData: CursorData = { cursors: [], selections: [] };

  // Intermittent local editor state
  private lastValue: string;
  private ignoreChanges: boolean = false;
  private composing: boolean = false;
  private oldDecorations: string[] = [];

  constructor(readonly options: RustpadOptions) {
    const stoppedOptions = stoppedEditorOptions.get(options.editor);
    if (stoppedOptions && options.editor.getDomNode()) {
      options.editor.updateOptions(stoppedOptions);
      stoppedEditorOptions.delete(options.editor);
    }
    this.model = options.editor.getModel()!;
    this.lastValue = this.model.getValue();
    this.onChangeHandle = options.editor.onDidChangeModelContent(() =>
      this.onChange(),
    );
    this.foldingImeHold = attachFoldingImeHold(options.editor);
    this.onCompositionStartHandle = options.editor.onDidCompositionStart(() => {
      this.composing = true;
      this.foldingImeHold.start();
    });
    this.onCompositionEndHandle = options.editor.onDidCompositionEnd(() => {
      this.composing = false;
      this.foldingImeHold.end();
      this.updateCursors();
    });
    const cursorUpdate = debounce(() => this.sendCursorData(), 20);
    this.onCursorHandle = options.editor.onDidChangeCursorPosition((e) => {
      this.onCursor(e);
      cursorUpdate();
    });
    this.onSelectionHandle = options.editor.onDidChangeCursorSelection((e) => {
      this.onSelection(e);
      cursorUpdate();
    });
    this.beforeUnload = (event: BeforeUnloadEvent) => {
      if (this.outstanding) {
        event.preventDefault();
        event.returnValue = "";
      } else {
        delete event.returnValue;
      }
    };
    window.addEventListener("beforeunload", this.beforeUnload);

    const interval = options.reconnectInterval ?? 1000;
    this.tryConnect();
    this.tryConnectId = window.setInterval(() => this.tryConnect(), interval);
    this.resetFailuresId = window.setInterval(
      () => (this.recentFailures = 0),
      15 * interval,
    );
  }

  /** Wait for the server to acknowledge all local edits currently in flight. */
  waitForSync(): Promise<void> {
    return this.waitForDrain(true);
  }

  private waitForDrain(requireReady: boolean): Promise<void> {
    if (this.syncFailure) return Promise.reject(this.syncFailure);
    if ((!requireReady || this.ready) && !this.outstanding && !this.buffer) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const waiter: SyncWaiter = {
        resolve,
        reject,
        requireReady,
        timeoutId: window.setTimeout(() => {
          this.syncWaiters.delete(waiter);
          reject(
            new Error(
              "Timed out waiting for the server to acknowledge edits. Copy any unsaved editor text manually, then reload the page.",
            ),
          );
        }, SYNC_TIMEOUT_MS),
      };
      this.syncWaiters.add(waiter);
    });
  }

  /** Stop editor input, drain acknowledged edits, and close this Rustpad. */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;

    if (this.options.editor.getDomNode() && !this.model.isDisposed()) {
      const rawOptions = this.options.editor.getRawOptions();
      stoppedEditorOptions.set(this.options.editor, {
        readOnly: rawOptions.readOnly ?? false,
        domReadOnly: rawOptions.domReadOnly ?? false,
      });
      this.options.editor.updateOptions({ readOnly: true, domReadOnly: true });
      this.onChange();
    }
    this.stopping = true;
    this.onSelectionHandle.dispose();
    this.onCursorHandle.dispose();
    this.onChangeHandle.dispose();
    this.foldingImeHold.dispose();
    this.onCompositionEndHandle.dispose();
    this.onCompositionStartHandle.dispose();

    if (
      (this.outstanding || this.buffer) &&
      (!this.ws || this.ws.readyState !== WebSocket.OPEN)
    ) {
      this.failSync(
        new Error(
          "The connection closed before the server acknowledged edits. Copy any unsaved editor text manually, then reload the page.",
        ),
      );
    }

    this.disposePromise = (async () => {
      try {
        await this.waitForDrain(false);
      } catch (error) {
        const syncError =
          error instanceof Error ? error : new Error(String(error));
        this.failSync(syncError);
        throw syncError;
      } finally {
        this.finishDispose();
      }
    })();
    return this.disposePromise;
  }

  private finishDispose() {
    if (this.disposed) return;
    this.disposed = true;
    window.clearInterval(this.tryConnectId);
    window.clearInterval(this.resetFailuresId);
    window.removeEventListener("beforeunload", this.beforeUnload);
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    this.connectingSocket?.close();
    this.connectingSocket = undefined;
    this.connecting = false;
    const error = new Error(
      "Rustpad was disposed before synchronization completed.",
    );
    this.syncWaiters.forEach((waiter) => {
      window.clearTimeout(waiter.timeoutId);
      waiter.reject(error);
    });
    this.syncWaiters.clear();
  }

  private resolveSyncWaiters() {
    if (this.outstanding || this.buffer) return;
    this.syncWaiters.forEach((waiter) => {
      if (waiter.requireReady && !this.ready) return;
      window.clearTimeout(waiter.timeoutId);
      waiter.resolve();
      this.syncWaiters.delete(waiter);
    });
  }

  private failSync(error: Error, terminal = true) {
    if (terminal && !this.syncFailure) this.syncFailure = error;
    const failure = this.syncFailure ?? error;
    this.syncWaiters.forEach((waiter) => {
      window.clearTimeout(waiter.timeoutId);
      waiter.reject(failure);
    });
    this.syncWaiters.clear();
  }

  /** Try to set the language of the editor, if connected. */
  setLanguage(language: string): boolean {
    this.ws?.send(`{"SetLanguage":${JSON.stringify(language)}}`);
    return this.ws !== undefined;
  }

  /** Try to set the title of the document, if connected. */
  setTitle(title: string): boolean {
    this.pendingTitle = title;
    this.sendPendingTitle();
    return this.ws !== undefined;
  }

  /** Set the user's information. */
  setInfo(info: UserInfo) {
    this.myInfo = info;
    this.sendInfo();
  }

  /**
   * Attempts a WebSocket connection.
   *
   * Safety Invariant: Until this WebSocket connection is closed, no other
   * connections will be attempted because either `this.ws` or
   * `this.connecting` will be set to a truthy value.
   *
   * Liveness Invariant: After this WebSocket connection closes, either through
   * error or successful end, both `this.connecting` and `this.ws` will be set
   * to falsy values.
   */
  private tryConnect() {
    if (this.stopping || this.disposed || this.connecting || this.ws) return;
    this.connecting = true;
    const ws = new WebSocket(this.options.uri);
    this.connectingSocket = ws;
    ws.onopen = () => {
      if (this.disposed) {
        ws.close();
        return;
      }
      this.connecting = false;
      this.connectingSocket = undefined;
      this.ws = ws;
      if (!this.stopping) this.options.onConnected?.();
      this.users = {};
      if (!this.stopping) {
        this.options.onChangeUsers?.(this.users);
        this.sendInfo();
        this.sendPendingTitle();
        this.sendCursorData();
      }
      if (this.outstanding) {
        this.sendOperation(this.outstanding);
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = undefined;
        if (!this.stopping) this.options.onDisconnected?.();
        if (
          (this.outstanding || this.buffer) &&
          (this.stopping || this.syncWaiters.size > 0)
        ) {
          const terminal = this.stopping || this.disposed;
          this.failSync(
            new Error(
              terminal
                ? "The connection closed before the server acknowledged edits. Copy any unsaved editor text manually, then reload the page."
                : "The connection closed before the server acknowledged edits. Retry after reconnecting.",
            ),
            terminal,
          );
        }
        if (++this.recentFailures >= 5) {
          // If we disconnect 5 times within 15 reconnection intervals, then the
          // client is likely desynchronized and needs to refresh.
          this.failSync(
            new Error(
              "The server repeatedly disconnected before edits synced.",
            ),
          );
          void this.dispose().catch((error) => {
            console.error("Failed to dispose desynchronized Rustpad", error);
          });
          this.options.onDesynchronized?.();
        }
      } else if (this.connectingSocket === ws) {
        this.connectingSocket = undefined;
        this.connecting = false;
      }
    };
    ws.onmessage = ({ data }) => {
      if (!this.disposed && typeof data === "string") {
        this.handleMessage(JSON.parse(data));
      }
    };
  }

  private handleMessage(msg: ServerMsg) {
    if (msg.Identity !== undefined) {
      this.me = msg.Identity;
    } else if (msg.History !== undefined) {
      const { start, operations } = msg.History;
      if (start > this.revision) {
        console.warn("History message has start greater than last operation.");
        this.ws?.close();
        return;
      }
      for (let i = this.revision - start; i < operations.length; i++) {
        let { id, operation } = operations[i];
        this.revision++;
        if (id === this.me) {
          this.serverAck();
        } else {
          operation = OpSeq.from_str(JSON.stringify(operation));
          this.applyServer(operation);
        }
      }
      this.markReady();
    } else if (msg.Language !== undefined) {
      if (this.stopping) return;
      this.options.onChangeLanguage?.(msg.Language);
    } else if (msg.Title !== undefined) {
      if (this.stopping) return;
      if (this.pendingTitle === msg.Title) {
        this.pendingTitle = undefined;
      }
      this.options.onChangeTitle?.(msg.Title);
    } else if (msg.UserInfo !== undefined) {
      if (this.stopping) return;
      const { id, info } = msg.UserInfo;
      if (id !== this.me) {
        this.users = { ...this.users };
        if (info) {
          this.users[id] = info;
        } else {
          delete this.users[id];
          delete this.userCursors[id];
        }
        this.updateCursors();
        this.options.onChangeUsers?.(this.users);
      }
    } else if (msg.UserCursor !== undefined) {
      if (this.stopping) return;
      const { id, data } = msg.UserCursor;
      if (id !== this.me) {
        this.userCursors[id] = data;
        this.updateCursors();
      }
    }
  }

  private markReady() {
    if (this.ready) return;
    this.ready = true;
    if (!this.stopping) this.options.onReady?.();
    this.resolveSyncWaiters();
  }

  private serverAck() {
    if (!this.outstanding) {
      console.warn("Received serverAck with no outstanding operation.");
      return;
    }
    this.outstanding = this.buffer;
    this.buffer = undefined;
    if (this.outstanding) {
      this.sendOperation(this.outstanding);
    }
    this.resolveSyncWaiters();
  }

  private applyServer(operation: OpSeq) {
    if (this.outstanding) {
      const pair = this.outstanding.transform(operation)!;
      this.outstanding = pair.first();
      operation = pair.second();
      if (this.buffer) {
        const pair = this.buffer.transform(operation)!;
        this.buffer = pair.first();
        operation = pair.second();
      }
    }
    if (!this.stopping) this.applyOperation(operation);
  }

  private applyClient(operation: OpSeq) {
    if (!this.outstanding) {
      this.sendOperation(operation);
      this.outstanding = operation;
    } else if (!this.buffer) {
      this.buffer = operation;
    } else {
      this.buffer = this.buffer.compose(operation);
    }
    this.transformCursors(operation);
  }

  private sendOperation(operation: OpSeq) {
    const op = operation.to_string();
    this.ws?.send(`{"Edit":{"revision":${this.revision},"operation":${op}}}`);
  }

  private sendInfo() {
    if (this.myInfo) {
      this.ws?.send(`{"ClientInfo":${JSON.stringify(this.myInfo)}}`);
    }
  }

  private sendPendingTitle() {
    if (this.pendingTitle !== undefined) {
      this.ws?.send(`{"SetTitle":${JSON.stringify(this.pendingTitle)}}`);
    }
  }

  private sendCursorData() {
    if (!this.buffer) {
      this.ws?.send(`{"CursorData":${JSON.stringify(this.cursorData)}}`);
    }
  }

  private applyOperation(operation: OpSeq) {
    if (operation.is_noop()) return;

    this.ignoreChanges = true;
    const ops: (string | number)[] = JSON.parse(operation.to_string());
    let index = 0;

    for (const op of ops) {
      if (typeof op === "string") {
        // Insert
        const pos = unicodePosition(this.model, index);
        index += unicodeLength(op);
        this.model.pushEditOperations(
          this.options.editor.getSelections(),
          [
            {
              range: {
                startLineNumber: pos.lineNumber,
                startColumn: pos.column,
                endLineNumber: pos.lineNumber,
                endColumn: pos.column,
              },
              text: op,
              forceMoveMarkers: true,
            },
          ],
          () => null,
        );
      } else if (op >= 0) {
        // Retain
        index += op;
      } else {
        // Delete
        const chars = -op;
        var from = unicodePosition(this.model, index);
        var to = unicodePosition(this.model, index + chars);
        this.model.pushEditOperations(
          this.options.editor.getSelections(),
          [
            {
              range: {
                startLineNumber: from.lineNumber,
                startColumn: from.column,
                endLineNumber: to.lineNumber,
                endColumn: to.column,
              },
              text: "",
              forceMoveMarkers: true,
            },
          ],
          () => null,
        );
      }
    }

    this.lastValue = this.model.getValue();
    this.ignoreChanges = false;

    this.transformCursors(operation);
  }

  private transformCursors(operation: OpSeq) {
    for (const data of Object.values(this.userCursors)) {
      data.cursors = data.cursors.map((c) => operation.transform_index(c));
      data.selections = data.selections.map(([s, e]) => [
        operation.transform_index(s),
        operation.transform_index(e),
      ]);
    }
    this.updateCursors();
  }

  private updateCursors() {
    // Decoration writes during IME composition can reset the native buffer.
    if (this.composing) return;

    const decorations: editor.IModelDeltaDecoration[] = [];

    for (const [id, data] of Object.entries(this.userCursors)) {
      if (id in this.users) {
        const { hue, name } = this.users[id as any];
        generateCssStyles(hue);

        for (const cursor of data.cursors) {
          const position = unicodePosition(this.model, cursor);
          decorations.push({
            options: {
              className: `remote-cursor-${hue}`,
              stickiness: 1,
              zIndex: 2,
            },
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: position.lineNumber,
              endColumn: position.column,
            },
          });
        }
        for (const selection of data.selections) {
          const position = unicodePosition(this.model, selection[0]);
          const positionEnd = unicodePosition(this.model, selection[1]);
          decorations.push({
            options: {
              className: `remote-selection-${hue}`,
              hoverMessage: {
                value: name,
              },
              stickiness: 1,
              zIndex: 1,
            },
            range: {
              startLineNumber: position.lineNumber,
              startColumn: position.column,
              endLineNumber: positionEnd.lineNumber,
              endColumn: positionEnd.column,
            },
          });
        }
      }
    }

    this.oldDecorations = this.model.deltaDecorations(
      this.oldDecorations,
      decorations,
    );
  }

  private onChange() {
    if (this.stopping || this.ignoreChanges || this.model.isDisposed()) return;

    // Rebuild the operation by diffing the previous value against the current
    // model value, rather than trusting Monaco's `event.changes`. On mobile,
    // IME/composition delivers pasted and typed text as a series of change
    // events that do not faithfully describe the delta from `lastValue`, which
    // would yield an operation with a mismatched base length and desynchronize
    // the client. A common prefix/suffix diff always produces a valid operation
    // that maps `lastValue` to the new model value.
    const oldValue = this.lastValue;
    const newValue = this.model.getValue();
    if (oldValue === newValue) return;

    const operation = diffText(oldValue, newValue);

    this.applyClient(operation);
    this.lastValue = newValue;
  }

  private onCursor(event: editor.ICursorPositionChangedEvent) {
    const cursors = [event.position, ...event.secondaryPositions];
    this.cursorData.cursors = cursors.map((p) => unicodeOffset(this.model, p));
  }

  private onSelection(event: editor.ICursorSelectionChangedEvent) {
    const selections = [event.selection, ...event.secondarySelections];
    this.cursorData.selections = selections.map((s) => [
      unicodeOffset(this.model, s.getStartPosition()),
      unicodeOffset(this.model, s.getEndPosition()),
    ]);
  }
}

type UserOperation = {
  id: number;
  operation: any;
};

type CursorData = {
  cursors: number[];
  selections: [number, number][];
};

type ServerMsg = {
  Identity?: number;
  History?: {
    start: number;
    operations: UserOperation[];
  };
  Language?: string;
  Title?: string;
  UserInfo?: {
    id: number;
    info: UserInfo | null;
  };
  UserCursor?: {
    id: number;
    data: CursorData;
  };
};

/** Returns the number of Unicode codepoints in a string. */
function unicodeLength(str: string): number {
  let length = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const c of str) ++length;
  return length;
}

/** Returns the number of Unicode codepoints before a position in the model. */
function unicodeOffset(model: editor.ITextModel, pos: IPosition): number {
  const value = model.getValue();
  const offsetUTF16 = model.getOffsetAt(pos);
  return unicodeLength(value.slice(0, offsetUTF16));
}

/** Returns the position after a certain number of Unicode codepoints. */
function unicodePosition(model: editor.ITextModel, offset: number): IPosition {
  const value = model.getValue();
  let offsetUTF16 = 0;
  for (const c of value) {
    // Iterate over Unicode codepoints
    if (offset <= 0) break;
    offsetUTF16 += c.length;
    offset -= 1;
  }
  return model.getPositionAt(offsetUTF16);
}

/** Cache for private use by `generateCssStyles()`. */
const generatedStyles = new Set<number>();

/** Add CSS styles for a remote user's cursor and selection. */
function generateCssStyles(hue: number) {
  if (!generatedStyles.has(hue)) {
    generatedStyles.add(hue);
    const css = `
      .monaco-editor .remote-selection-${hue} {
        background-color: hsla(${hue}, 90%, 80%, 0.5);
      }
      .monaco-editor .remote-cursor-${hue} {
        border-left: 2px solid hsl(${hue}, 90%, 25%);
      }
    `;
    const element = document.createElement("style");
    const text = document.createTextNode(css);
    element.appendChild(text);
    document.head.appendChild(element);
  }
}

export default Rustpad;
