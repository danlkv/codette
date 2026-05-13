// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

export class RpcServer {
  constructor() {
    this.handlers = new Map();
  }

  register(name, fn) {
    this.handlers.set(name, fn);
    return this;
  }

  // Returns true if the message was an RPC request and was handled.
  async handle(ws, msg) {
    if (!msg.id || !this.handlers.has(msg.type)) return false;
    const type = msg.type;
    try {
      const result = await this.handlers.get(type)(msg);
      ws.send(JSON.stringify({ id: msg.id, result }));
      this.onSend?.(type);
    } catch (e) {
      ws.send(JSON.stringify({ id: msg.id, error: e.message }));
      this.onSend?.(type);
    }
    return true;
  }
}
