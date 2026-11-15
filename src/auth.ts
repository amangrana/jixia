import { runProcess, subscriptionEnv } from './cli.ts';
import type { Provider } from './cli.ts';

// "走订阅，不走 API" is a hard constraint. Clearing API-key variables for each
// call does not cover a CLI that was itself logged in with an API key, so ask
// each CLI how it is logged in before using it. This costs no quota.
//
// What this does and does not establish: the CLI reported a subscription login
// when the app started. It is not a check of the actual bill.

export type LoginKind = 'subscription' | 'api-key' | 'not-logged-in' | 'unknown';
export type LoginStatus = { kind: LoginKind; detail: string };

export function parseClaudeStatus(stdout: string): LoginStatus {
  let status: { loggedIn?: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string };
  try { status = JSON.parse(stdout); } catch { return { kind: 'unknown', detail: '无法解析 claude auth status 的输出' }; }
  if (status.loggedIn === false) return { kind: 'not-logged-in', detail: 'Claude Code 未登录' };
  if (status.loggedIn === true && status.authMethod === 'claude.ai' && status.subscriptionType) return { kind: 'subscription', detail: `Claude 订阅登录（${status.subscriptionType}）` };
  if (status.loggedIn === true && status.authMethod && status.authMethod !== 'claude.ai') return { kind: 'api-key', detail: `Claude Code 的登录方式是 ${status.authMethod}，不是订阅` };
  return { kind: 'unknown', detail: 'Claude Code 的登录类型无法确认' };
}

export function parseCodexStatus(output: string): LoginStatus {
  if (/Logged in using ChatGPT/i.test(output)) return { kind: 'subscription', detail: 'ChatGPT 订阅登录' };
  if (/Logged in using an? API key/i.test(output)) return { kind: 'api-key', detail: 'Codex 用 API key 登录，不是订阅' };
  if (/Not logged in/i.test(output)) return { kind: 'not-logged-in', detail: 'Codex 未登录' };
  return { kind: 'unknown', detail: 'Codex 的登录类型无法确认' };
}

export type RunStatus = (executable: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
const defaultRun: RunStatus = (executable, args) => runProcess(executable, args, { cwd: process.cwd(), input: '', timeoutMs: 20000, env: subscriptionEnv() });

export async function checkLogin(provider: Provider, run: RunStatus = defaultRun): Promise<LoginStatus> {
  try {
    if (provider === 'claude') return parseClaudeStatus((await run('claude', ['auth', 'status', '--json'])).stdout);
    const result = await run('codex', ['login', 'status']);
    return parseCodexStatus(`${result.stdout}\n${result.stderr}`); // Codex prints this on stderr.
  } catch (error) {
    return { kind: 'unknown', detail: `无法查询登录状态：${error instanceof Error ? error.message : String(error)}` };
  }
}
