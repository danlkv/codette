// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov
//
// File-based OAuth state adapter for node-oidc-provider.
// Each model (AuthorizationCode, AccessToken, RefreshToken, Grant, Session, ...)
// gets a separate JSON file under $OAUTH_DATA_DIR. Atomic writes via tmp+rename.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';

function dataDir() { return process.env.OAUTH_DATA_DIR || '/data/oauth'; }

function ensureDir() { try { mkdirSync(dataDir(), { recursive: true, mode: 0o700 }); } catch {} }

function load(model) {
  try { return JSON.parse(readFileSync(join(dataDir(), model + '.json'), 'utf8')); }
  catch { return {}; }
}

function save(model, data) {
  ensureDir();
  const path = join(dataDir(), model + '.json');
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, path);
}

export class FileAdapter {
  constructor(name) { this.name = name; }

  async upsert(id, payload, expiresIn) {
    const data = load(this.name);
    data[id] = { payload, expiresAt: Date.now() + expiresIn * 1000 };
    if (payload.grantId) data[id].grantId = payload.grantId;
    if (payload.userCode) data[id].userCode = payload.userCode;
    if (payload.uid) data[id].uid = payload.uid;
    save(this.name, data);
  }

  async find(id) {
    const data = load(this.name);
    const entry = data[id];
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      delete data[id];
      save(this.name, data);
      return undefined;
    }
    return entry.payload;
  }

  async findByUserCode(userCode) {
    const data = load(this.name);
    for (const [id, entry] of Object.entries(data)) {
      if (entry.userCode === userCode) return this.find(id);
    }
    return undefined;
  }

  async findByUid(uid) {
    const data = load(this.name);
    for (const [id, entry] of Object.entries(data)) {
      if (entry.uid === uid) return this.find(id);
    }
    return undefined;
  }

  async consume(id) {
    const data = load(this.name);
    if (data[id]) {
      data[id].payload.consumed = Math.floor(Date.now() / 1000);
      save(this.name, data);
    }
  }

  async destroy(id) {
    const data = load(this.name);
    delete data[id];
    save(this.name, data);
  }

  async revokeByGrantId(grantId) {
    const data = load(this.name);
    let changed = false;
    for (const id of Object.keys(data)) {
      if (data[id].grantId === grantId) {
        delete data[id];
        changed = true;
      }
    }
    if (changed) save(this.name, data);
  }
}
