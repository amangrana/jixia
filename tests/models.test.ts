import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_INIT, loadModels, parseClaudeModels, parseCodexModels, queryModels } from '../src/models.ts';
import type { RunQuery } from '../src/models.ts';

// Shapes copied from what the two CLIs printed on this machine. No CLI is started here.
const CODEX = JSON.stringify({ models: [
  { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'max' }, { effort: 'ultra' }] },
  { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
  { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'max' }] },
  { slug: 'bad name"; rm', display_name: 'Injected', visibility: 'list', supported_reasoning_levels: [] },
] });
const CLAUDE = [
  '{"type":"system","subtype":"init"}',
  JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'jixia-models', response: { models: [
    { value: 'default', resolvedModel: 'claude-fable-5-2', displayName: 'Default (recommended)', supportedEffortLevels: ['low', 'medium', 'high'] },
    { value: 'sonnet', displayName: 'Sonnet 5.5', supportedEffortLevels: ['low', 'medium', 'high'] },
    { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
  ] } } }),
].join('\n');
const ok = (stdout: string) => ({ stdout, exitCode: 0, timedOut: false });

test('Codex catalog: hidden and oddly named models are left out; the default offers only levels every model accepts', () => {
  assert.deepEqual(parseCodexModels(CODEX), {
    models: [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', efforts: ['low', 'medium', 'max', 'ultra'] }, { id: 'gpt-6-luna', name: 'GPT-6-Luna', efforts: ['low', 'medium', 'max'] }],
    defaultEfforts: ['low', 'medium', 'max'],
  });
  assert.throws(() => parseCodexModels('{"models":[]}'), /没有列出/);
  assert.throws(() => parseCodexModels('{}'), /没有模型列表/);
  assert.throws(() => parseCodexModels('not json'));
});

test('Claude Code list: "default" only lends its effort levels; a model without effort support has none', () => {
  assert.deepEqual(parseClaudeModels(CLAUDE), {
    models: [{ id: 'sonnet', name: 'Sonnet 5.5', efforts: ['low', 'medium', 'high'] }, { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', efforts: [] }],
    defaultEfforts: ['low', 'medium', 'high'],
  });
  assert.throws(() => parseClaudeModels('{"type":"result","is_error":true}'), /没有模型列表/);
});

test('the queries send no prompt: a control request to Claude Code, a debug command to Codex', async () => {
  const calls: { executable: string; args: string[]; input: string }[] = [];
  const run: RunQuery = async (executable, args, input) => { calls.push({ executable, args, input }); return ok(executable === 'claude' ? CLAUDE : CODEX); };
  assert.equal((await queryModels('claude', run)).models.length, 2);
  assert.equal((await queryModels('codex', run)).models.length, 2);
  assert.deepEqual(calls[1], { executable: 'codex', args: ['debug', 'models'], input: '' });
  assert.equal(calls[0].input, CLAUDE_INIT + '\n');
  assert(calls[0].args.includes('--input-format') && calls[0].args.includes('--strict-mcp-config') && calls[0].args.at(-1) === '');
  await assert.rejects(queryModels('codex', async () => ({ stdout: CODEX, exitCode: 2, timedOut: false })), /退出码 2/);
  await assert.rejects(queryModels('claude', async () => ({ stdout: '', exitCode: null, timedOut: true })), /超时/);
});

test('a failed query keeps the last saved list and says so; with nothing saved the list is empty', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jixia-models-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cachePath = join(directory, 'data', 'models.json');
  const good: RunQuery = async executable => ok(executable === 'claude' ? CLAUDE : CODEX);
  const first = await loadModels({ cachePath, providers: ['claude', 'codex', 'claude'], workDir: directory, run: good });
  assert.equal(first.claude.models.length, 2);
  assert.equal(first.codex.note, undefined);
  assert.equal(JSON.parse(await readFile(cachePath, 'utf8')).codex.models[0].id, 'gpt-6.1-sol');

  // Next start: Codex changed its debug command, Claude Code still answers.
  const second = await loadModels({ cachePath, providers: ['claude', 'codex'], workDir: directory, run: async executable => { if (executable === 'codex') throw new Error('unrecognized subcommand'); return ok(CLAUDE); } });
  assert.deepEqual(second.codex.models.map(model => model.id), ['gpt-6.1-sol', 'gpt-6-luna']);
  assert.deepEqual(second.codex.defaultEfforts, ['low', 'medium', 'max']);
  assert.match(second.codex.note!, /Codex 的模型列表没有更新（unrecognized subcommand），沿用 \d{4}-\d\d-\d\d 查到的列表/);
  assert.equal(second.claude.note, undefined);

  // Never queried before, and a damaged file: no list, a note, no exception.
  await writeFile(cachePath, '{"claude": {"models": [{"id": "x; y", "name": "bad", "efforts": []}], "updatedAt": "2026-01-01"}}');
  const third = await loadModels({ cachePath, providers: ['claude'], workDir: directory, run: async () => { throw new Error('not installed'); } });
  assert.deepEqual(third.claude.models, []);
  assert.match(third.claude.note!, /查不到 Claude Code 的模型列表（not installed），只能用默认模型/);
  assert.deepEqual(third.codex, { models: [], defaultEfforts: [] }); // Not asked for.
});
