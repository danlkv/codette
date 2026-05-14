// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

export class RpcServer {
  constructor() {
    this.handlers = new Map();
    this.encryptResult = null; // async (result) => {nonce, ciphertext} or null
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
      let result = await this.handlers.get(type)(msg);
      const skipEncrypt = type === 'auth_challenge' || type === 'auth_verify';
      if (this.encryptResult && result != null && !skipEncrypt) result = await this.encryptResult(result, type);
      ws.send(JSON.stringify({ id: msg.id, result }));
      this.onSend?.(type);
    } catch (e) {
      let payload = { id: msg.id, error: e.message };
      const skipEncrypt = type === 'auth_challenge' || type === 'auth_verify';
      if (this.encryptResult && !skipEncrypt) {
        try {
          const encrypted = await this.encryptResult({ error: e.message }, type);
          payload = { id: msg.id, result: encrypted };
        } catch { /* encrypt failed, send plaintext error */ }
      }
      ws.send(JSON.stringify(payload));
      this.onSend?.(type);
    }
    return true;
  }
}
