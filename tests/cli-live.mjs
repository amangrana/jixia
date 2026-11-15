// Live check of src/cli.ts against the real CLIs. Each run makes four short
// model calls (two per provider) and uses subscription quota. Not part of `npm test`.
//   node tests/cli-live.mjs            both providers
//   node tests/cli-live.mjs claude     one provider
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const providers = process.argv.length > 2 ? process.argv.slice(2) : ['claude', 'codex'];
const workDir = await mkdtemp(join(tmpdir(), 'jixia-live-work-'));
let failed = false;
const check = async (provider, name, prompt, verify) => {
  const started = Date.now();
  try {
    const output = await runCli({ provider, workDir, readDir: root, timeoutMs: 120000 }, prompt);
    const ok = verify(output);
    failed ||= !ok;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${provider} ${name} ${Date.now() - started}ms ${JSON.stringify(output)}`);
  } catch (error) {
    failed = true;
    console.log(`FAIL ${provider} ${name} ${Date.now() - started}ms ${error.kind ?? ''} ${error.message} ${error.detail ?? ''}`);
  }
};
try {
  await Promise.all(providers.map(async provider => {
    await check(provider, 'plain-reply', '不要使用任何工具。reply 只写：中文测试成功。不要提出任何写记忆请求。',
      output => output.reply.includes('中文测试成功') && output.memoryRequests.length === 0);
    await check(provider, 'memory-request', '不要使用任何工具。用户说：“记住这个：我偏好简短的中文回答。”请在 reply 里简短确认，并提出一条写入公共记忆（target 为 common）的请求。',
      output => output.memoryRequests.length === 1 && output.memoryRequests[0].target === 'common' && output.memoryRequests[0].content.includes('简短'));
  }));
} finally {
  await rm(workDir, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
