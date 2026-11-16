import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { checkLogin, parseClaudeStatus, parseCodexStatus } from '../src/auth.ts';
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.ts';
import { createLimiter } from '../src/limiter.ts';

test('the limiter never runs more than the cap, and runs everything in order', async () => {
  const limit = createLimiter(2);
  let running = 0, peak = 0;
  const finished: number[] = [];
  await Promise.all(Array.from({ length: 7 }, (_, index) => limit(async () => {
    peak = Math.max(peak, ++running);
    await new Promise(resolve => setTimeout(resolve, 15));
    running--;
    finished.push(index);
  })));
  assert.equal(peak, 2);
  assert.deepEqual(finished, [0, 1, 2, 3, 4, 5, 6]);
  // A failing task releases its slot.
  await assert.rejects(limit(async () => { throw new Error('boom'); }));
  assert.equal(await limit(async () => 'still works'), 'still works');
  assert.throws(() => createLimiter(0));
});

test('Claude login: only a claude.ai subscription counts', () => {
  assert.equal(parseClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' })).kind, 'subscription');
  assert.equal(parseClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: 'console', apiProvider: 'firstParty' })).kind, 'api-key');
  assert.equal(parseClaudeStatus(JSON.stringify({ loggedIn: false })).kind, 'not-logged-in');
  assert.equal(parseClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })).kind, 'unknown');
  assert.equal(parseClaudeStatus('not json').kind, 'unknown');
});

test('Codex login: ChatGPT counts, an API key does not, anything else is unknown', () => {
  assert.equal(parseCodexStatus('Logged in using ChatGPT').kind, 'subscription');
  assert.equal(parseCodexStatus('Logged in using an API key - sk-***').kind, 'api-key');
  assert.equal(parseCodexStatus('Not logged in').kind, 'not-logged-in');
  assert.equal(parseCodexStatus('').kind, 'unknown');
});

test('the login check reads Codex status from stderr and turns a failed query into unknown', async () => {
  const calls: string[] = [];
  const run = async (executable: string, args: string[]) => { calls.push([executable, ...args].join(' ')); return executable === 'codex' ? { stdout: '', stderr: 'Logged in using ChatGPT\n' } : { stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}', stderr: '' }; };
  assert.equal((await checkLogin('codex', run)).kind, 'subscription');
  assert.equal((await checkLogin('claude', run)).kind, 'subscription');
  assert.deepEqual(calls, ['codex login status', 'claude auth status --json']);
  assert.equal((await checkLogin('claude', async () => { throw new Error('not installed'); })).kind, 'unknown');
});

test('config: defaults without a file, overrides merge, and mistakes are rejected by name', () => {
  assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG);
  const config = resolveConfig({ port: 5000, bots: { claude: { provider: 'claude', model: 'sonnet', effort: 'low' } } });
  assert.equal(config.port, 5000);
  assert.deepEqual(Object.keys(config.bots), ['claude']);
  assert.equal(config.maxParallelCli, DEFAULT_CONFIG.maxParallelCli);
  assert.throws(() => resolveConfig({ prot: 5000 }), /不认识的配置项：prot/);
  assert.throws(() => resolveConfig({ maxParallelCli: 0 }), /maxParallelCli 必须是正整数/);
  assert.throws(() => resolveConfig({ bots: { '../x': { provider: 'claude' } } }), /名字/);
  assert.throws(() => resolveConfig({ bots: { all: { provider: 'claude' } }, defaultWriter: 'all' }), /名字/);
  assert.throws(() => resolveConfig({ bots: { gemini: { provider: 'gemini' } }, defaultWriter: 'gemini' }), /provider/);
  assert.equal(resolveConfig({ bots: { chatgpt: { provider: 'codex', model: 'gpt-6-luna', effort: 'low' } }, defaultWriter: 'chatgpt' }).bots.chatgpt.effort, 'low');
  // These end up as CLI arguments, and for Codex inside a TOML string.
  assert.throws(() => resolveConfig({ bots: { chatgpt: { provider: 'codex', effort: 'low" x="1' } }, defaultWriter: 'chatgpt' }), /effort 必须是/);
  assert.throws(() => resolveConfig({ bots: { claude: { provider: 'claude', model: 'son net' } } }), /model 必须是/);
  assert.throws(() => resolveConfig({ bots: { chatgpt: { provider: 'codex' } } }), /defaultWriter/);
  assert.throws(() => resolveConfig({ requireSubscription: 'no' }), /requireSubscription/);
  assert.equal(resolveConfig({ keepCliSessions: true }).keepCliSessions, true);
  assert.throws(() => resolveConfig({ keepCliSessions: 'yes' }), /keepCliSessions/);
  assert.equal(resolveConfig({ webSearch: true }).webSearch, true);
  assert.throws(() => resolveConfig({ webSearch: 1 }), /webSearch/);
  assert.deepEqual(resolveConfig({ discussion: { rounds: 4 } }).discussion, { rounds: 4 });
  for (const rounds of [0, 5, 2.5]) assert.throws(() => resolveConfig({ discussion: { rounds } }), /discussion.rounds/);
  assert.throws(() => resolveConfig({ discussion: { round: 2 } }), /不认识的配置项：round/);
  assert.deepEqual(resolveConfig({ compact: { keepRounds: 5 } }).compact, { ...DEFAULT_CONFIG.compact, keepRounds: 5 });
  // Claude's default model and effort do not follow a switch to Codex.
  assert.deepEqual(resolveConfig({ compact: { provider: 'codex' } }).compact, { provider: 'codex', thresholdTokens: 40_000, keepRounds: 3, maxSummaryTokens: 4_000 });
  assert.throws(() => resolveConfig({ compact: { treshold: 1 } }), /compact 里有不认识的配置项：treshold/);
  assert.throws(() => resolveConfig({ compact: { keepRounds: 0 } }), /compact\.keepRounds/);
  assert.equal(resolveConfig({ compact: { provider: 'codex', effort: 'low' } }).compact.effort, 'low');
  assert.throws(() => resolveConfig({ compact: { effort: 'lo w' } }), /compact\.effort/);
  assert.throws(() => resolveConfig({ compact: { maxSummaryTokens: 50_000 } }), /maxSummaryTokens 必须小于/);
});

test('config.example.yaml is valid and spells out exactly the defaults', async () => {
  assert.deepEqual(resolveConfig(parse(await readFile('config.example.yaml', 'utf8'))), DEFAULT_CONFIG);
});
