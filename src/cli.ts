import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Headless calls to the locally logged-in Claude Code and Codex CLIs.
// Flags follow "实测确定的调用方式" in the design doc; evidence is in
// "jixia CLI 实测记录.md". Change them only together with a new probe.

import type { MemoryRequest } from './memory.ts';

export type Provider = 'claude' | 'codex';
export type { MemoryRequest };
/** `model` and `effort` say what answered; they are added by runCli, never taken from the bot's own output. */
export type BotOutput = { reply: string; memoryRequests: MemoryRequest[]; model?: string; effort?: string };

/** Shown when no model was configured and the CLI does not report which one it used. */
export const DEFAULT_MODEL_LABEL = '默认模型';

/**
 * The model that answered. Claude Code reports it per call; when it lists
 * several (a small model can do side work), the one that wrote the most output
 * is the answer's. Codex does not report it, so that is the configured model.
 */
export function usedModel(provider: Provider, stdout: string, configured: string | undefined): string {
  if (provider === 'claude') {
    try {
      const usage = (JSON.parse(stdout) as { modelUsage?: Record<string, { outputTokens?: number }> }).modelUsage ?? {};
      const [name] = Object.entries(usage).sort((a, b) => (b[1]?.outputTokens ?? 0) - (a[1]?.outputTokens ?? 0))[0] ?? [];
      if (name) return name;
    } catch { /* fall through to what was configured */ }
  }
  return configured ?? DEFAULT_MODEL_LABEL;
}

export type CliConfig = {
  provider: Provider;
  /** Empty directory the CLI starts in. Must already exist. */
  workDir: string;
  /** Directory Claude Code may read (the jixia folder). Codex ignores it: its read-only sandbox already reads outside the work directory. */
  readDir: string;
  timeoutMs: number;
  executable?: string;
  model?: string;
  effort?: string;
  env?: NodeJS.ProcessEnv;
};

export type CliFailure = 'spawn' | 'timeout' | 'exit' | 'invalid-output';
export class CliError extends Error {
  kind: CliFailure;
  detail: string;
  constructor(kind: CliFailure, message: string, detail = '') { super(message); this.name = 'CliError'; this.kind = kind; this.detail = detail; }
}

// Every field required and no extras: Codex rejects looser schemas, and the
// scheduler must never guess at a half-formed memory request.
export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    memoryRequests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['common', 'self'] },
          op: { type: 'string', enum: ['append'] },
          content: { type: 'string' },
        },
        required: ['target', 'op', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['reply', 'memoryRequests'],
  additionalProperties: false,
} as const;

const hasOnlyKeys = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => key in value);

/** Checks the business object ourselves rather than trusting the CLI's schema enforcement. */
export function validateOutput(data: unknown): BotOutput {
  const fail = (why: string): never => { throw new CliError('invalid-output', `输出不符合约定格式：${why}`); };
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return fail('不是对象');
  const output = data as Record<string, unknown>;
  if (!hasOnlyKeys(output, ['reply', 'memoryRequests'])) return fail('字段不对');
  if (typeof output.reply !== 'string') return fail('reply 不是字符串');
  if (!Array.isArray(output.memoryRequests)) return fail('memoryRequests 不是数组');
  for (const request of output.memoryRequests) {
    if (typeof request !== 'object' || request === null || !hasOnlyKeys(request, ['target', 'op', 'content'])) return fail('写记忆请求的字段不对');
    const { target, op, content } = request as Record<string, unknown>;
    if (target !== 'common' && target !== 'self') return fail('target 只能是 common 或 self');
    if (op !== 'append') return fail('op 只接受 append');
    if (typeof content !== 'string') return fail('content 不是字符串');
  }
  return output as BotOutput;
}

/**
 * Where each part of the prompt goes. Claude Code's prompt cache reuses whole
 * blocks only, and everything on stdin is one block: a prompt that differs in
 * its last line is written to the cache again in full and never read back.
 * The system prompt is a block of its own, so the part that rarely changes
 * goes there and is read from the cache while it stays the same. Measured in
 * "实现前的实测" of the design doc.
 *
 * Codex gets everything on stdin: no placement made its cache hit reliably.
 */
export function splitPrompt(provider: Provider, prompt: string, stable: string | undefined): { system?: string; stdin: string } {
  if (provider !== 'claude' || !stable || !prompt.startsWith(stable + '\n')) return { stdin: prompt };
  return { system: stable, stdin: prompt.slice(stable.length + 1) };
}

/** `files` are the per-call temp paths: Codex's schema and answer, and for Claude the system prompt file when there is one. */
export function buildArgs(config: CliConfig, files: { schema: string; final: string; system?: string }): string[] {
  if (config.provider === 'claude') {
    return [
      '-p',
      '--tools', 'Read', '--allowedTools', 'Read', '--add-dir', config.readDir,
      '--strict-mcp-config', '--permission-mode', 'dontAsk', '--no-session-persistence',
      // Passed as an argument array, so the empty string survives; a shell would drop it.
      '--setting-sources', '',
      '--settings', JSON.stringify({ claudeMdExcludes: ['**'], autoMemoryEnabled: false, disableAllHooks: true }),
      ...(config.model ? ['--model', config.model] : []),
      ...(config.effort ? ['--effort', config.effort] : []),
      // A file, not an argument: memory and a summary would exceed the Windows command line limit.
      // Appended, so Claude Code's own system prompt stays as it is.
      ...(files.system ? ['--append-system-prompt-file', files.system] : []),
      '--output-format', 'json',
      '--json-schema', JSON.stringify(OUTPUT_SCHEMA),
    ];
  }
  return [
    'exec',
    '--ignore-user-config',
    // --ignore-user-config drops the Windows sandbox setting; without it every command is blocked.
    ...(process.platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : []),
    '-c', 'project_doc_max_bytes=0',
    '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral',
    ...(config.model ? ['--model', config.model] : []),
    // The value is TOML; callers only pass plain tokens (see MODEL_TOKEN), so quoting it is enough.
    ...(config.effort ? ['-c', `model_reasoning_effort="${config.effort}"`] : []),
    '--json',
    '--output-schema', files.schema,
    '--output-last-message', files.final,
    '-',
  ];
}

// Credentials or endpoints that would route a call to API billing instead of
// the subscription login. Removed only from the child's environment.
const BILLING_OVERRIDE = /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL)|OPENAI_(?:API_KEY|BASE_URL|API_BASE)|CODEX_API_KEY|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY))$/i;
export function subscriptionEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !BILLING_OVERRIDE.test(name)));
}

export type ProcessResult = {
  stdout: string; stderr: string; exitCode: number | null; pid: number | undefined;
  timedOut: boolean;
  /** True when the process and its output pipes are confirmed closed. False means we stopped waiting. */
  reaped: boolean;
};

// Only the PID from this exact spawn, never a process name. /T takes the
// console host and any tool subprocesses with it. Asynchronous so a slow
// taskkill cannot stall other groups; its outcome is confirmed by `close`.
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    killer.once('error', () => {});
    killer.unref();
  } else try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

export const DEFAULT_GRACE_MS = 5000;

/**
 * Runs one process with the prompt on stdin. Always settles within
 * timeoutMs + graceMs: a process that cannot be killed, or a descendant that
 * keeps the output pipes open after the main process exits, must not block
 * the group's queue forever.
 */
export function runProcess(executable: string, args: string[], options: { cwd: string; input: string; timeoutMs: number; graceMs?: number; env?: NodeJS.ProcessEnv; kill?: (pid: number) => void }): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    let stdout = '', stderr = '', timedOut = false, settled = false;
    let grace: NodeJS.Timeout | undefined;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    // The child may exit before reading all of stdin (bad flag, early failure).
    child.stdin.on('error', () => {});
    const finish = (reaped: boolean) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(grace);
      if (!reaped) {
        // Let go of whatever still holds the pipes so it cannot keep us, or the app, waiting.
        child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); child.unref();
      }
      resolve({ stdout, stderr, exitCode: child.exitCode, pid: child.pid, timedOut, reaped });
    };
    // `close` normally follows within milliseconds of the kill or the exit.
    // The grace period bounds the wait when it does not.
    const startGrace = () => { grace ??= setTimeout(() => finish(false), graceMs); };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      if (child.pid !== undefined && child.exitCode === null) (options.kill ?? killTree)(child.pid);
      startGrace();
    }, options.timeoutMs);
    child.once('error', error => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(grace);
      reject(new CliError('spawn', `无法启动 ${executable}`, error.message));
    });
    child.once('exit', startGrace);
    child.once('close', () => finish(true));
    child.stdin.end(options.input);
  });
}

/** Pulls the business object out of what the CLI produced. `final` is Codex's --output-last-message file content. */
export function parseOutput(provider: Provider, stdout: string, final: string | undefined): BotOutput {
  let data: unknown;
  try {
    if (provider === 'claude') {
      const envelope = JSON.parse(stdout) as { is_error?: boolean; result?: unknown; structured_output?: unknown };
      if (envelope.is_error) throw new CliError('invalid-output', 'Claude Code 报告调用出错', String(envelope.result ?? ''));
      data = envelope.structured_output;
    } else {
      if (!final?.trim()) throw new CliError('invalid-output', 'Codex 没有给出最终回答');
      data = JSON.parse(final);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('invalid-output', '输出不是合法的 JSON', (error as Error).message);
  }
  return validateOutput(data);
}

const NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex' };
const tail = (text: string) => text.trim().slice(-2000);

/**
 * One fresh headless call: full prompt in, validated reply and memory requests out. Throws CliError on any failure.
 * `stable` is the leading part of `prompt` that rarely changes between calls; see splitPrompt.
 */
export async function runCli(config: CliConfig, prompt: string, stable?: string): Promise<BotOutput> {
  const scratch = await mkdtemp(join(tmpdir(), 'jixia-cli-'));
  try {
    const { system, stdin } = splitPrompt(config.provider, prompt, stable);
    const files = { schema: join(scratch, 'schema.json'), final: join(scratch, 'final.json'), ...(system === undefined ? {} : { system: join(scratch, 'system.md') }) };
    if (config.provider === 'codex') await writeFile(files.schema, JSON.stringify(OUTPUT_SCHEMA), 'utf8');
    if (system !== undefined) await writeFile(files.system!, system, 'utf8');
    const result = await runProcess(config.executable ?? config.provider, buildArgs(config, files), {
      cwd: config.workDir,
      input: stdin.endsWith('\n') ? stdin : stdin + '\n',
      timeoutMs: config.timeoutMs,
      env: subscriptionEnv(config.env),
    });
    if (result.timedOut) {
      const waited = `${NAME[config.provider]} 超过 ${Math.round(config.timeoutMs / 1000)} 秒没有回答`;
      throw new CliError('timeout', result.reaped ? `${waited}，已终止` : `${waited}，进程回收未确认（PID ${result.pid}），可能仍在运行`);
    }
    // exitCode 0 with reaped false: the CLI finished, but something it started
    // still held the pipes. Its answer is complete, so use it.
    if (result.exitCode !== 0) throw new CliError('exit', `${NAME[config.provider]} 异常退出（退出码 ${result.exitCode}）`, tail(result.stderr || result.stdout));
    const final = config.provider === 'codex' ? await readFile(files.final, 'utf8').catch(() => undefined) : undefined;
    const output = parseOutput(config.provider, result.stdout, final);
    return { ...output, model: usedModel(config.provider, result.stdout, config.model), ...(config.effort ? { effort: config.effort } : {}) };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
