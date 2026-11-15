import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_INIT, loadModels, parseClaudeModels, parseCodexModels, queryModels } from '../src/models.ts';
import type { OpenRpc, RunQuery } from '../src/models.ts';

// Shapes copied from what the two CLIs returned on this machine. No CLI is started here.
const effort = (...names: string[]) => names.map(name => ({ reasoningEffort: name, description: '' }));
const CODEX_PAGE_1 = { data: [
  { id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', hidden: false, isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: effort('low', 'medium', 'max', 'ultra') },
  { id: 'gpt-reserve', model: 'gpt-reserve', displayName: 'GPT-Reserve', hidden: true, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: effort('low') },
], nextCursor: 'page-2' };
const CODEX_PAGE_2 = { data: [
  { id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6-Luna', hidden: false, isDefault: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: effort('low', 'medium', 'max') },
  { id: 'x', model: 'bad name"; rm', displayName: 'Injected', hidden: false, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [] },
], nextCursor: null };
const CLAUDE = [
  '{"type":"system","subtype":"init"}',
  JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'jixia-models', response: { models: [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks', supportedEffortLevels: ['low', 'medium', 'high'] },
    { value: 'sonnet', displayName: 'Sonnet 5.5', supportedEffortLevels: ['low', 'medium', 'high'] },
    { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
  ] } } }),
].join('\n');
const ok = (stdout: string) => ({ stdout, exitCode: 0, timedOut: false });

// A stand-in for `codex app-server` that records what was asked.
function fakeCodex(pages: unknown[] = [CODEX_PAGE_1, CODEX_PAGE_2]) {
  const calls: { method: string; params: unknown }[] = [];
  let closed = 0;
  const open: OpenRpc = async () => ({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'initialize') return { userAgent: 'codex' };
      const cursor = (params as { cursor?: string }).cursor;
      return cursor === 'page-2' ? pages[1] : pages[0];
    },
    close: () => { closed++; },
  });
  return { open, calls, closed: () => closed };
}

test('Codex list: the default model and each model\'s default effort are kept; hidden and oddly named models are left out', () => {
  assert.deepEqual(parseCodexModels([CODEX_PAGE_1, CODEX_PAGE_2]), {
    models: [
      { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'max', 'ultra'], defaultEffort: 'low' },
      { id: 'gpt-6-luna', name: 'GPT-6-Luna', efforts: ['low', 'medium', 'max'], defaultEffort: 'medium' },
    ],
    defaultEfforts: ['low', 'medium', 'max', 'ultra'],
    defaultModel: { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' },
    defaultEffort: 'low',
  });
  // No model marked as default: the "no choice" entry offers only levels every model accepts.
  const unmarked = parseCodexModels([{ data: CODEX_PAGE_1.data.map(item => ({ ...item, isDefault: false })) }, CODEX_PAGE_2]);
  assert.deepEqual([unmarked.defaultModel, unmarked.defaultEffort, unmarked.defaultEfforts], [undefined, undefined, ['low', 'medium', 'max']]);
  assert.throws(() => parseCodexModels([{ data: [] }]), /没有列出/);
  assert.throws(() => parseCodexModels([{}]), /没有列出/);
});

test('Claude Code list: "default" gives the default model and its effort levels, not a default effort', () => {
  assert.deepEqual(parseClaudeModels(CLAUDE), {
    models: [{ id: 'sonnet', name: 'Sonnet 5.5', efforts: ['low', 'medium', 'high'] }, { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', efforts: [] }],
    defaultEfforts: ['low', 'medium', 'high'],
    defaultModel: { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  });
  assert.throws(() => parseClaudeModels('{"type":"result","is_error":true}'), /没有模型列表/);
});

test('the queries send no prompt: a control request to Claude Code, model/list pages from the Codex app server', async () => {
  const calls: { executable: string; args: string[]; input: string }[] = [];
  const run: RunQuery = async (executable, args, input) => { calls.push({ executable, args, input }); return ok(CLAUDE); };
  const codex = fakeCodex();
  assert.equal((await queryModels('claude', { run, openCodex: codex.open })).models.length, 2);
  assert.equal(calls[0].input, CLAUDE_INIT + '\n');
  assert(calls[0].args.includes('--input-format') && calls[0].args.includes('--strict-mcp-config') && calls[0].args.at(-1) === '');
  assert.equal((await queryModels('codex', { run, openCodex: codex.open })).models.length, 2);
  assert.deepEqual(codex.calls.map(call => [call.method, call.params]), [['initialize', { clientInfo: { name: 'jixia', title: 'jixia', version: '1' } }], ['model/list', {}], ['model/list', { cursor: 'page-2' }]]);
  assert.equal(codex.closed(), 1);
  // The session is closed even when the server refuses.
  const refusing: OpenRpc = async () => ({ request: async () => { throw new Error('unknown method'); }, close: () => { refused++; } });
  let refused = 0;
  await assert.rejects(queryModels('codex', { run, openCodex: refusing }), /unknown method/);
  assert.equal(refused, 1);
  await assert.rejects(queryModels('claude', { run: async () => ({ stdout: '', exitCode: null, timedOut: true }), openCodex: codex.open }), /超时/);
});

test('a failed query keeps the last saved list, defaults included, and says so; with nothing saved the list is empty', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jixia-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cachePath = join(directory, 'data', 'models.json');
  const run: RunQuery = async () => ok(CLAUDE);
  const first = await loadModels({ cachePath, providers: ['claude', 'codex', 'claude'], workDir: directory, run, openCodex: fakeCodex().open });
  assert.equal(first.claude.models.length, 2);
  assert.equal(first.codex.note, undefined);
  assert.equal(JSON.parse(await readFile(cachePath, 'utf8')).codex.defaultModel.id, 'gpt-6.1-sol');

  // Next start: the Codex app server is gone, Claude Code still answers.
  const second = await loadModels({ cachePath, providers: ['claude', 'codex'], workDir: directory, run, openCodex: async () => { throw new Error('无法启动 codex'); } });
  assert.deepEqual(second.codex.models.map(model => [model.id, model.defaultEffort]), [['gpt-6.1-sol', 'low'], ['gpt-6-luna', 'medium']]);
  assert.deepEqual([second.codex.defaultModel, second.codex.defaultEffort], [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }, 'low']);
  assert.match(second.codex.note!, /Codex 的模型列表没有更新（无法启动 codex），沿用 \d{4}-\d\d-\d\d 查到的列表/);
  assert.equal(second.claude.note, undefined);

  // Never queried before, and a damaged file: no list, a note, no exception.
  await writeFile(cachePath, '{"claude": {"models": [{"id": "x; y", "name": "bad", "efforts": []}], "defaultModel": {"id": "a b", "name": "x"}, "updatedAt": "2026-01-01"}}');
  const third = await loadModels({ cachePath, providers: ['claude'], workDir: directory, run: async () => { throw new Error('not installed'); }, openCodex: fakeCodex().open });
  assert.deepEqual([third.claude.models, third.claude.defaultModel], [[], undefined]);
  assert.match(third.claude.note!, /查不到 Claude Code 的模型列表（not installed），只能用默认模型/);
  assert.deepEqual(third.codex, { models: [], defaultEfforts: [] }); // Not asked for.
});
