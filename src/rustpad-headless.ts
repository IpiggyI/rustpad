import { OpSeq } from "rustpad-wasm";

import { diffText } from "./textDiff";

export type RustpadHeadlessOptions = {
  readonly uri: string;
  readonly onConnected?: () => void;
  readonly onDisconnected?: () => void;
  readonly onDesynchronized?: () => void;
  readonly onContentReady?: (text: string) => void;
  readonly onContentChanged?: (text: string) => void;
  readonly reconnectInterval?: number;
};

type UserOperation = {
  id: number;
  operation: any;
};

type ServerMsg = {
  Identity?: number;
  History?: {
    start: number;
    operations: UserOperation[];
  };
  Language?: string;
  UserInfo?: unknown;
  UserCursor?: unknown;
};

function applyToString(content: string, operation: OpSeq): string {
  const ops: (string | number)[] = JSON.parse(operation.to_string());
  let result = "";
  let index = 0;

  const codepoints = Array.from(content);

  for (const op of ops) {
    if (typeof op === "string") {
      result += op;
    } else if (op >= 0) {
      result += codepoints.slice(index, index + op).join("");
      index += op;
    } else {
      index += -op;
    }
  }

  return result;
}

class RustpadHeadless {
  private ws?: WebSocket;
  private connecting?: boolean;
  private recentFailures: number = 0;
  private readonly tryConnectId: number;
  private readonly resetFailuresId: number;

  private me: number = -1;
  private revision: number = 0;
  private outstanding?: OpSeq;
  private buffer?: OpSeq;
  private outstandingSent: boolean = false;
  private disposing: boolean = false;
  private closed: boolean = false;

  private content: string = "";
  private contentReady: boolean = false;

  readonly options: RustpadHeadlessOptions;

  constructor(options: RustpadHeadlessOptions) {
    this.options = options;
    const interval = options.reconnectInterval ?? 1000;
    this.tryConnect();
    this.tryConnectId = window.setInterval(() => this.tryConnect(), interval);
    this.resetFailuresId = window.setInterval(
      () => (this.recentFailures = 0),
      15 * interval,
    );
  }

  dispose(): Promise<void> {
    this.disposing = true;
    window.clearInterval(this.tryConnectId);
    window.clearInterval(this.resetFailuresId);
    return this.flushThenClose();
  }

  getContent(): string {
    return this.content;
  }

  replaceContent(newText: string) {
    if (newText === this.content) return;
    const operation = diffText(this.content, newText);
    this.content = newText;
    this.applyClient(operation);
  }

  private tryConnect() {
    if (this.connecting || this.ws || this.closed) return;
    this.connecting = true;
    const ws = new WebSocket(this.options.uri);
    ws.onopen = () => {
      this.connecting = false;
      this.ws = ws;
      this.options.onConnected?.();
      if (this.outstanding) {
        this.sendOperation(this.outstanding);
      }
    };
    ws.onclose = () => {
      if (this.ws) {
        this.ws = undefined;
        if (this.disposing) return;
        this.options.onDisconnected?.();
        if (++this.recentFailures >= 5) {
          this.dispose();
          this.options.onDesynchronized?.();
        }
      } else {
        this.connecting = false;
      }
    };
    ws.onmessage = ({ data }) => {
      if (typeof data === "string") {
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
      this.markContentReady();
    }
  }

  private markContentReady() {
    if (this.contentReady) return;
    this.contentReady = true;
    this.options.onContentReady?.(this.content);
  }

  private serverAck() {
    if (!this.outstanding) {
      console.warn("Received serverAck with no outstanding operation.");
      return;
    }
    this.outstanding = this.buffer;
    this.buffer = undefined;
    this.outstandingSent = false;
    if (this.outstanding) {
      this.sendOperation(this.outstanding);
    }
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
    this.applyOperation(operation);
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
  }

  private sendOperation(operation: OpSeq) {
    if (!this.ws) return;
    const op = operation.to_string();
    this.ws.send(`{"Edit":{"revision":${this.revision},"operation":${op}}}`);
    this.outstandingSent = true;
  }

  private waitForSocket(timeoutMs: number): Promise<boolean> {
    if (this.ws) return Promise.resolve(true);
    this.tryConnect();
    return new Promise((resolve) => {
      const started = Date.now();
      const id = window.setInterval(() => {
        if (this.ws) {
          window.clearInterval(id);
          resolve(true);
        } else if (Date.now() - started >= timeoutMs) {
          window.clearInterval(id);
          resolve(false);
        }
      }, 10);
    });
  }

  private async flushThenClose(): Promise<void> {
    try {
      if (this.buffer || (this.outstanding && !this.outstandingSent)) {
        const timeoutMs = Math.min(
          this.options.reconnectInterval ?? 1000,
          1000,
        );
        await this.waitForSocket(timeoutMs);
      }
      if (!this.ws) return;
      if (this.outstanding && !this.outstandingSent) {
        this.sendOperation(this.outstanding);
      }
      if (this.buffer) {
        const revision = this.outstanding ? this.revision + 1 : this.revision;
        const op = this.buffer.to_string();
        this.ws.send(`{"Edit":{"revision":${revision},"operation":${op}}}`);
        this.buffer = undefined;
      }
    } finally {
      this.closed = true;
      this.ws?.close();
      this.ws = undefined;
    }
  }

  private applyOperation(operation: OpSeq) {
    if (operation.is_noop()) return;
    this.content = applyToString(this.content, operation);
    this.options.onContentChanged?.(this.content);
  }
}

export default RustpadHeadless;
