import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_USAGE, createQuotaMonitor, parseClaudeUsage, parseCodexUsage, queryQuota } from '../src/quota.ts';
import type { OpenRpc, RunQuery } from '../src/models.ts';

// Shapes copied from what the two CLIs returned on this machine. No CLI is started here.
const claudeLine = (rateLimits: unknown, extra = {}) => JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'jixia-usage', response: { subscription_type: 'pro', rate_limits_available: true, rate_limits: rateLimits, ...extra } } });
const CLAUDE = ['{"type":"system","subtype":"init"}', claudeLine({
  five_hour: { utilization: 34, resets_at: '2026-11-15T17:59:59.801763-05:00' },
  seven_day: { utilization: 15, resets_at: '2026-11-21T04:59:59.801784-05:00' },
  seven_day_opus: null,
})].join('\n');
const CODEX = { rateLimits: {
  primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1794775280 },
  secondary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1795126067 },
  planType: 'plus',
} };

test('Claude Code usage: the five-hour and seven-day windows', () => {
  assert.deepEqual(parseClaudeUsage(CLAUDE), {
    fiveHour: { usedPercent: 34, resetsAt: '2026-11-15T22:59:59.801Z' },
    weekly: { usedPercent: 15, resetsAt: '2026-11-21T09:59:59.801Z' },
  });
  // A window that is missing is left out; a value outside 0-100 is clamped.
  assert.deepEqual(parseClaudeUsage(claudeLine({ five_hour: { utilization: 104.4 }, seven_day: null })), { fiveHour: { usedPercent: 100 } });
  assert.throws(() => parseClaudeUsage(claudeLine({ five_hour: null, seven_day: null })), /没有额度数据/);
  assert.throws(() => parseClaudeUsage(claudeLine(null, { rate_limits_available: false })), /没有提供额度数据/);
  assert.throws(() => parseClaudeUsage(JSON.stringify({ type: 'control_response', response: { subtype: 'error', error: 'Unsupported control request subtype: get_usage' } })), /Unsupported/);
  assert.throws(() => parseClaudeUsage('{"type":"result"}'), /没有回应/);
});

test('Codex usage: windows are told apart by their length, not by which slot they are in', () => {
  assert.deepEqual(parseCodexUsage(CODEX), {
    fiveHour: { usedPercent: 20, resetsAt: new Date(1794775280 * 1000).toISOString() },
    weekly: { usedPercent: 17, resetsAt: new Date(1795126067 * 1000).toISOString() },
  });
  const swapped = { rateLimits: { primary: CODEX.rateLimits.secondary, secondary: CODEX.rateLimits.primary } };
  assert.deepEqual(parseCodexUsage(swapped), parseCodexUsage(CODEX));
  // An unknown window length (a daily one, say) is not shown as either.
  assert.deepEqual(parseCodexUsage({ rateLimits: { primary: { usedPercent: 50, windowDurationMins: 1440 }, secondary: CODEX.rateLimits.secondary } }), { weekly: parseCodexUsage(CODEX).weekly });
  assert.throws(() => parseCodexUsage({ rateLimits: { primary: null, secondary: null } }), /没有额度数据/);
  assert.throws(() => parseCodexUsage(null), /没有返回/);
});

test('the queries call no model: a get_usage control request, and account/rateLimits/read on the app server', async () => {
  const runs: { args: string[]; input: string }[] = [];
  const run: RunQuery = async (_executable, args, input) => { runs.push({ args, input }); return { stdout: CLAUDE, exitCode: 0, timedOut: false }; };
  const methods: string[] = [];
  let closed = 0;
  const openCodex: OpenRpc = async () => ({ request: async method => { methods.push(method); return method === 'initialize' ? {} : CODEX; }, close: () => { closed++; } });
  assert.equal((await queryQuota('claude', { run, openCodex })).fiveHour?.usedPercent, 34);
  assert.equal(runs[0].input, CLAUDE_USAGE + '\n');
  assert(runs[0].args.includes('--input-format') && !runs[0].args.includes('--model'));
  assert.equal((await queryQuota('codex', { run, openCodex })).weekly?.usedPercent, 17);
  assert.deepEqual([methods, closed], [['initialize', 'account/rateLimits/read'], 1]);
});

test('the monitor keeps the last reading when a read fails, says why, and runs one read at a time', async () => {
  let claudeOk = true, reads = 0;
  let release: (() => void) | undefined;
  const run: RunQuery = async () => {
    reads++;
    if (release === undefined && reads === 3) await new Promise<void>(resolve => { release = resolve; });
    if (!claudeOk) throw new Error('无法启动 claude');
    return { stdout: CLAUDE, exitCode: 0, timedOut: false };
  };
  const openCodex: OpenRpc = async () => { throw new Error('codex 未安装'); };
  const times = ['2026-11-15T12:00:00.000Z', '2026-11-15T12:05:00.000Z', '2026-11-15T12:10:00.000Z'];
  let tick = 0;
  const monitor = createQuotaMonitor({ providers: ['claude', 'codex', 'claude'], deps: { run, openCodex }, now: () => new Date(times[Math.min(tick, 2)]) });
  const pushed: unknown[] = [];
  monitor.subscribe(states => pushed.push(states));

  await monitor.refresh();
  assert.deepEqual(monitor.get(), {
    claude: { quota: parseClaudeUsage(CLAUDE), checkedAt: times[0] },
    codex: { error: 'codex 未安装' }, // Never read: nothing to show but the reason.
  });
  assert.equal(pushed.length, 1);

  // Claude fails now: its last reading stays, with its time, plus the reason.
  claudeOk = false; tick = 1;
  await monitor.refresh();
  assert.deepEqual(monitor.get().claude, { quota: parseClaudeUsage(CLAUDE), checkedAt: times[0], error: '无法启动 claude' });

  // Two refreshes at once share one read.
  claudeOk = true; tick = 2;
  const both = Promise.all([monitor.refresh(), monitor.refresh()]);
  await new Promise(resolve => setTimeout(resolve, 20));
  release!();
  await both;
  assert.equal(reads, 3);
  assert.deepEqual(monitor.get().claude, { quota: parseClaudeUsage(CLAUDE), checkedAt: times[2] });
  assert.equal(pushed.length, 3);
});
