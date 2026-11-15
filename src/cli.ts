import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Headless calls to the locally logged-in Claude Code and Codex CLIs.
// Flags follow "实测确定的调用方式" in the design doc; evidence is in
// "jixia CLI 实测记录.md". Change them only together with a new probe.

export type Provider = 'claude' | 'codex';
export type MemoryRequest = { target: 'common' | 'self'; op: 'append'; content: string };
export type BotOutput = { reply: string; memoryRequests: MemoryRequest[] };

export type CliConfig = {
  provider: Provider;
  /** Empty directory the CLI starts in. Must already exist. */
  workDir: string;
  /** Directory Claude Code may read (the jixia folder). Codex ignores it: its read-only sandbox already reads outside the work directory. */
  readDir: string;
  timeoutMs: number;
  executable?: string;
  model?: string;
  /** Claude Code only; the Codex equivalent has not been probed yet. */
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

/** `files` are the per-call temp paths Codex needs; Claude takes the schema inline. */
export function buildArgs(config: CliConfig, files: { schema: string; final: string }): string[] {
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

export type ProcessResult = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean };

function killTree(pid: number): void {
  // Only the PID from this exact spawn, never a process name. /T takes the
  // console host and any tool subprocesses with it.
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
  else try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

/** Runs one process with the prompt on stdin. Resolves only after the process has closed, including after a timeout kill. */
export function runProcess(executable: string, args: string[], options: { cwd: string; input: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, settled = false;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    // The child may exit before reading all of stdin (bad flag, early failure).
    child.stdin.on('error', () => {});
    const timer = setTimeout(() => {
      if (settled || child.pid === undefined || child.exitCode !== null) return;
      timedOut = true;
      killTree(child.pid);
    }, options.timeoutMs);
    child.once('error', error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new CliError('spawn', `无法启动 ${executable}`, error.message));
    });
    child.once('close', exitCode => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
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

/** One fresh headless call: full prompt in, validated reply and memory requests out. Throws CliError on any failure. */
export async function runCli(config: CliConfig, prompt: string): Promise<BotOutput> {
  const scratch = await mkdtemp(join(tmpdir(), 'jixia-cli-'));
  try {
    const files = { schema: join(scratch, 'schema.json'), final: join(scratch, 'final.json') };
    if (config.provider === 'codex') await writeFile(files.schema, JSON.stringify(OUTPUT_SCHEMA), 'utf8');
    const result = await runProcess(config.executable ?? config.provider, buildArgs(config, files), {
      cwd: config.workDir,
      input: prompt.endsWith('\n') ? prompt : prompt + '\n',
      timeoutMs: config.timeoutMs,
      env: subscriptionEnv(config.env),
    });
    if (result.timedOut) throw new CliError('timeout', `${NAME[config.provider]} 超过 ${Math.round(config.timeoutMs / 1000)} 秒没有回答，已终止`);
    if (result.exitCode !== 0) throw new CliError('exit', `${NAME[config.provider]} 异常退出（退出码 ${result.exitCode}）`, tail(result.stderr || result.stdout));
    const final = config.provider === 'codex' ? await readFile(files.final, 'utf8').catch(() => undefined) : undefined;
    return parseOutput(config.provider, result.stdout, final);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
