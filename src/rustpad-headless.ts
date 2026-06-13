import { OpSeq } from "rustpad-wasm";

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

function unicodeLength(str: string): number {
  return Array.from(str).length;
}

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

function buildReplaceOp(oldText: string, newText: string): OpSeq {
  const oldLen = unicodeLength(oldText);
  const op = OpSeq.new();
  op.delete(oldLen);
  op.insert(newText);
  return op;
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

  private content: string = "";
  private contentReady: boolean = false;
  private contentReadyId?: number;

  constructor(readonly options: RustpadHeadlessOptions) {
    const interval = options.reconnectInterval ?? 1000;
    this.tryConnect();
    this.tryConnectId = window.setInterval(() => this.tryConnect(), interval);
    this.resetFailuresId = window.setInterval(
      () => (this.recentFailures = 0),
      15 * interval,
    );
  }

  dispose() {
    window.clearInterval(this.tryConnectId);
    window.clearInterval(this.resetFailuresId);
    if (this.contentReadyId !== undefined) {
      window.clearTimeout(this.contentReadyId);
    }
    this.ws?.close();
  }

  getContent(): string {
    return this.content;
  }

  replaceContent(newText: string) {
    if (newText === this.content) return;
    const operation = buildReplaceOp(this.content, newText);
    this.content = newText;
    this.applyClient(operation);
  }

  private tryConnect() {
    if (this.connecting || this.ws) return;
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
      this.contentReadyId = window.setTimeout(() => this.markContentReady(), 100);
    } else if (msg.History !== undefined) {
      if (this.contentReadyId !== undefined) {
        window.clearTimeout(this.contentReadyId);
        this.contentReadyId = undefined;
      }
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
    this.contentReadyId = undefined;
    this.options.onContentReady?.(this.content);
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
    const op = operation.to_string();
    this.ws?.send(`{"Edit":{"revision":${this.revision},"operation":${op}}}`);
  }

  private applyOperation(operation: OpSeq) {
    if (operation.is_noop()) return;
    this.content = applyToString(this.content, operation);
    this.options.onContentChanged?.(this.content);
  }
}

export default RustpadHeadless;
