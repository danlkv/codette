// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Danylo Lykov

// ── Session abstraction ──────────────────────────────────────────────────────
// Backend-agnostic interface for a Claude session.
// Callbacks: onLine(line), onInit(sessionId, ev), onState('streaming'|'idle'|'stopped')
//
// Both createSpawnSession and createSdkSession return the same shape:
//   { sessionId, streaming, onLine, onInit, onState, send(obj), stop(), interrupt() }

import { spawn } from 'child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';

export function createSpawnSession(args, cwd) {
  const proc = spawn(args[0], args.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(cwd && { cwd }),
  });

  const session = {
    sessionId: null,
    streaming: false,
    onLine: null,
    onInit: null,
    onState: null,

    send(obj) { proc.stdin.write(JSON.stringify(obj) + '\n'); },
    stop()    { proc.kill(); },
    interrupt() { proc.kill('SIGUSR1'); },
  };

  let buf = '';

  proc.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
  });

  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;

      let ev = null;
      try { ev = JSON.parse(line); } catch {}

      if (ev) {
        if (ev.type === 'system' && ev.subtype === 'init') {
          session.sessionId = ev.session_id ?? null;
          session.onInit?.(session.sessionId, ev);
        }

        if (ev.type === 'assistant' && !session.streaming) {
          session.streaming = true;
          session.onState?.('streaming');
        }

        if (ev.type === 'result') {
          session.streaming = false;
          session.onState?.('idle');
        }
      }

      session.onLine?.(line);
    }
  });

  proc.on('exit', () => {
    session.streaming = false;
    session.onState?.('stopped');
  });

  return session;
}

export function createSdkSession({ cwd, permissionMode, resume, allowedTools, systemPrompt, model, queryFn = query } = {}) {
  let inputResolve = null;
  const inputQueue = [];

  const session = {
    sessionId: null,
    streaming: false,
    onLine: null,
    onInit: null,
    onState: null,
    onPermission: null,

    send(obj) {
      // Extract content for the SDK — it expects SDKUserMessage shape
      const content = obj.message?.content ?? obj.content ?? '';
      inputQueue.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      });
      inputResolve?.();
    },
    stop()      { abortController.abort('stop'); inputResolve?.(); },
    interrupt() { q?.interrupt(); },
    setModel(m) { return q.setModel(m); },
  };

  const abortController = new AbortController();

  async function* messageGenerator() {
    while (!abortController.signal.aborted) {
      if (inputQueue.length) {
        yield inputQueue.shift();
      } else {
        await new Promise(r => { inputResolve = r; });
      }
    }
  }

  const effectiveMode = permissionMode || 'bypassPermissions';

  const options = {
    permissionMode: effectiveMode,
    ...(effectiveMode === 'bypassPermissions' && { allowDangerouslySkipPermissions: true }),
    includePartialMessages: true,
    abortController,
    ...(cwd && { cwd }),
    ...(resume && { resume }),
    ...(model && { model }),
    ...(allowedTools && { allowedTools }),
    ...(systemPrompt && { systemPrompt }),
    canUseTool: async (toolName, input, ctx) => {
      if (!session.onPermission) return { behavior: 'allow' };
      return new Promise((resolve, reject) => {
        const handler = { resolve, reject };
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
        session.onPermission({ toolName, input, toolUseId: ctx.toolUseID,
          title: ctx.title, displayName: ctx.displayName, description: ctx.description, handler });
      });
    },
  };

  const q = queryFn({ prompt: messageGenerator(), options });

  // Run the SDK loop in the background
  (async () => {
    try {
      for await (const msg of q) {
        const line = JSON.stringify(msg);

        if (msg.type === 'system' && msg.session_id) {
          session.sessionId = msg.session_id;
          session.onInit?.(msg.session_id, msg);
        }

        if (msg.type === 'assistant' && !session.streaming) {
          session.streaming = true;
          session.onState?.('streaming');
        }

        if (msg.type === 'result') {
          session.streaming = false;
          session.onState?.('idle');
        }

        session.onLine?.(line);
      }
    } catch (e) {
      if (e !== 'stop' && e !== 'interrupt') {
        process.stderr.write(`sdk session error: ${e.message ?? e}\n`);
      }
    }
    session.streaming = false;
    session.onState?.('stopped');
  })();

  return session;
}
