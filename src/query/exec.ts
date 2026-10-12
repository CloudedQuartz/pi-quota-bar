import { spawn } from 'node:child_process';
import { QuotaError } from './types.ts';
import type { QuotaAdapter, QuotaSnapshot } from './types.ts';

export interface ExecOptions { command: string[]; label: string }

export function validateExecOptions(options: { command?: unknown; label?: unknown }): ExecOptions {
  const { command, label } = options;
  if (!Array.isArray(command) || command.length === 0 || command.length > 16
    || command.some(part => typeof part !== 'string' || part.trim() === '' || part.length > 512)) {
    throw new Error('Invalid exec options');
  }
  if (typeof label !== 'string' || label.trim() === '' || label.length > 64) throw new Error('Invalid exec options');
  return { command: [...command] as string[], label };
}

// Same bound as the HTTP clients: quota payloads are small.
const MAX_OUTPUT_BYTES = 256 * 1024;

function runCommand(command: readonly string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => { if (!settled) { settled = true; reject(error); } };
    const done = (text: string) => { if (!settled) { settled = true; resolve(text); } };
    let child;
    try {
      // No shell: argv passes verbatim; settings.json is the only trust boundary.
      // The controller bounds the wait via the signal even if the child hangs.
      child = spawn(command[0], command.slice(1), { signal, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { fail(new QuotaError('network')); return; }
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > MAX_OUTPUT_BYTES) { child.kill(); fail(new QuotaError('schema')); }
    });
    child.on('error', () => fail(signal.aborted ? signal.reason : new QuotaError('network')));
    child.on('close', code => {
      if (signal.aborted) fail(signal.reason);
      else if (code !== 0) fail(new QuotaError('network'));
      else done(output);
    });
  });
}

export function createExecAdapter(provider: string, options: ExecOptions): QuotaAdapter {
  return {
    provider, label: options.label,
    async query(context) {
      const text = await runCommand(options.command, context.signal);
      let payload: unknown;
      try { payload = JSON.parse(text); } catch { throw new QuotaError('schema'); }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new QuotaError('schema');
      // fetchedAt is stamped here, never trusted from the command; the
      // controller's validateSnapshot performs the real schema check.
      return { ...(payload as Record<string, unknown>), fetchedAt: context.now() } as QuotaSnapshot;
    },
  };
}
