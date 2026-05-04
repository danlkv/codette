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
    try {
      const result = await this.handlers.get(msg.type)(msg);
      ws.send(JSON.stringify({ id: msg.id, result }));
    } catch (e) {
      ws.send(JSON.stringify({ id: msg.id, error: e.message }));
    }
    return true;
  }
}
