// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

import { randomUUID } from 'crypto';

export class RpcClient {
  constructor() {
    this.pending = new Map(); // id → { timer, callback }
  }

  call(ws, type, params, callback, timeout = 30000) {
    const id = randomUUID();
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) callback(new Error(`${type} timed out`), null);
    }, timeout);
    this.pending.set(id, { timer, callback });
    ws.send(JSON.stringify({ id, type, ...params }));
    return id;
  }

  cancel(id) {
    const entry = this.pending.get(id);
    if (entry) { clearTimeout(entry.timer); this.pending.delete(id); }
  }

  flush(err = new Error('host disconnected')) {
    for (const { timer, callback } of this.pending.values()) {
      clearTimeout(timer);
      callback(err, null);
    }
    this.pending.clear();
  }

  // Returns true if the message was an RPC reply and was consumed.
  handle(ev) {
    if (!ev.id) return false;
    const entry = this.pending.get(ev.id);
    if (!entry) return false;
    this.pending.delete(ev.id);
    clearTimeout(entry.timer);
    ev.error ? entry.callback(new Error(ev.error), null)
             : entry.callback(null, ev.result);
    return true;
  }
}
