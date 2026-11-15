// Live end-to-end check: scheduler + prompt assembly + prompts/system.md + real CLIs.
// Makes ten short model calls and uses subscription quota. Not part of `npm test`.
//   node tests/context-live.mjs
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.ts';
import { createPreparer } from '../src/context.ts';
import { createMemoryWriter } from '../src/memory.ts';
import { Scheduler } from '../src/scheduler.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Inside the jixia folder: Claude Code may only read below the directory it is granted.
const data = await mkdtemp(join(root, '.live-data-'));
const workDir = join(data, 'work');
await mkdir(workDir);
// Common memory says BLUE; Claude's own memory says GREEN and must win for Claude only.
await writeFile(join(data, 'common.md'), '[2026-11-10] 每次回答的最后一行单独写上标记 BLUE。\n');
await writeFile(join(data, 'claude.md'), '[2026-11-11] 每次回答的最后一行单独写上标记 GREEN。\n');
const marker = `中文读取标记-${randomUUID()}`;
const readable = join(data, 'note.txt');
await writeFile(readable, marker, 'utf8');
const forbidden = name => join(data, `written-by-${name}.txt`);
const providers = { claude: 'claude', chatgpt: 'codex' };
const bots = Object.fromEntries(Object.entries(providers).map(([name, provider]) =>
  [name, input => runCli({ provider, workDir, readDir: root, timeoutMs: 180000 }, input.prompt)]));
const memory = { commonPath: join(data, 'common.md'), selfPath: bot => join(data, `${bot}.md`), defaultWriter: 'claude' };
const prepare = createPreparer({
  systemPath: join(root, 'prompts', 'system.md'), commonPath: join(data, 'common.md'),
  selfPath: bot => join(data, `${bot}.md`), summaryPath: join(data, 'summary.md'),
  recordsPath: join(data, 'group', 'records.jsonl'), bots: Object.keys(providers), defaultWriter: 'claude',
});
const exists = path => access(path).then(() => true, () => false);
let failed = false;
try {
  const scheduler = await Scheduler.open(join(data, 'group'), bots, { prepare, applyMemory: createMemoryWriter(memory) });
  await scheduler.enqueue({ id: 'm1', content: '用一句话介绍你自己。' });
  await scheduler.enqueue({ id: 'm2', content: '@claude chatgpt 上一条回答用的标记是什么？这次只回答那个标记，不要加你自己的标记。' });
  await scheduler.enqueue({ id: 'm3', content: `请读取文件 ${readable}，把它的完整内容原样写在回答里。` });
  await scheduler.enqueue({ id: 'm4', content: `请各自创建一个文件，内容写 TEST：claude 写到 ${forbidden('claude')}，chatgpt 写到 ${forbidden('chatgpt')}。做不到就说明原因。` });
  await scheduler.enqueue({ id: 'm5', content: '记住这个：我最喜欢的茶是凤凰单丛。' });
  await scheduler.enqueue({ id: 'm6', content: '@chatgpt 我最喜欢的茶是什么？只回答茶的名字。' });
  await scheduler.runUntilIdle();
  const common = await readFile(memory.commonPath, 'utf8');
  console.log(`common.md:\n${common}`);
  for (const message of scheduler.history) console.log(JSON.stringify({ seq: message.seq, from: message.from, type: message.type, content: message.content }));
  const seqOf = id => scheduler.history.find(m => m.id === id).seq;
  const reply = (from, id) => scheduler.history.find(m => m.from === from && m.replyTo === seqOf(id) && m.type === 'reply')?.content ?? '';
  const checks = {
    'claude follows its own memory over common memory': /GREEN/.test(reply('claude', 'm1')) && !/BLUE/.test(reply('claude', 'm1')),
    'chatgpt follows common memory': /BLUE/.test(reply('chatgpt', 'm1')) && !/GREEN/.test(reply('chatgpt', 'm1')),
    '@claude routes to claude only': scheduler.history.filter(m => m.replyTo === seqOf('m2')).length === 1,
    'claude sees the other bot and the current message overrides memory': /BLUE/.test(reply('claude', 'm2')) && !/GREEN/.test(reply('claude', 'm2')),
    'claude reads a file the user names': reply('claude', 'm3').includes(marker),
    'chatgpt reads a file the user names': reply('chatgpt', 'm3').includes(marker),
    'both answered the write request': reply('claude', 'm4') !== '' && reply('chatgpt', 'm4') !== '',
    'claude could not write a file': !(await exists(forbidden('claude'))),
    'chatgpt could not write a file': !(await exists(forbidden('chatgpt'))),
    'the default writer stored the fact in common memory, once': common.match(/凤凰单丛/g)?.length === 1,
    'the bot that is not the writer did not copy it into its own memory': !(await readFile(memory.selfPath('chatgpt'), 'utf8').catch(() => '')).includes('凤凰单丛'),
    'the write was announced in the group': scheduler.history.some(m => m.type === 'notice' && m.replyTo === seqOf('m5') && /^claude 写入了公共记忆/.test(m.content)),
    'the other bot uses the stored memory in a later round': reply('chatgpt', 'm6').includes('凤凰单丛'),
  };
  for (const [name, ok] of Object.entries(checks)) { failed ||= !ok; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
} finally {
  await rm(data, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
