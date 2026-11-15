// Live check of the quota reads against both real CLIs. Calls no model and
// spends no quota. Not part of `npm test`.
//   node tests/quota-live.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRun, openCodexAppServer } from '../src/models.ts';
import { createQuotaMonitor } from '../src/quota.ts';

for (const name of Object.keys(process.env)) if (/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$)/.test(name)) delete process.env[name];
const work = await mkdtemp(join(tmpdir(), 'jixia-quota-'));
let failed = false;
try {
  const monitor = createQuotaMonitor({ providers: ['claude', 'codex'], deps: { run: defaultRun(work), openCodex: openCodexAppServer(work) } });
  const started = Date.now();
  await monitor.refresh();
  const took = Date.now() - started;
  const states = monitor.get();
  for (const [provider, state] of Object.entries(states)) console.log(provider, JSON.stringify(state));
  const sane = window => window && window.usedPercent >= 0 && window.usedPercent <= 100 && window.resetsAt && Date.parse(window.resetsAt) > Date.now();
  const checks = {
    'claude: both windows read, with a future reset time': !states.claude?.error && sane(states.claude?.quota?.fiveHour) && sane(states.claude?.quota?.weekly),
    'codex: both windows read, with a future reset time': !states.codex?.error && sane(states.codex?.quota?.fiveHour) && sane(states.codex?.quota?.weekly),
    'the five-hour window resets within five hours': ['claude', 'codex'].every(p => Date.parse(states[p]?.quota?.fiveHour?.resetsAt ?? '') - Date.now() <= 5 * 3600_000 + 60_000),
    'the weekly window resets within seven days': ['claude', 'codex'].every(p => Date.parse(states[p]?.quota?.weekly?.resetsAt ?? '') - Date.now() <= 7 * 86400_000 + 60_000),
    [`both reads took under 10 seconds together (${took} ms)`]: took < 10000,
  };
  for (const [name, ok] of Object.entries(checks)) { failed ||= !ok; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); }
} finally {
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exitCode = failed ? 1 : 0;
