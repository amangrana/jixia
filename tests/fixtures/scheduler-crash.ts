import { Scheduler } from '../../src/scheduler.ts';
import { setTimeout } from 'node:timers/promises';

const scheduler = await Scheduler.open(process.argv[2], {
  claude: async () => 'saved answer',
  codex: async () => new Promise<string>(() => {}),
});
await scheduler.enqueue({ id: 'active', content: 'first', targets: ['claude', 'codex'] });
await scheduler.enqueue({ id: 'waiting', content: 'second', targets: ['claude'] });
void scheduler.runUntilIdle();
while (!scheduler.history.some(m => m.type === 'reply')) await setTimeout(10);
console.log('CRASH_READY');
setInterval(() => {}, 1000);
