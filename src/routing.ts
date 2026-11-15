// Decide which bots answer a message, following the design doc's routing table:
// no mention or @all -> every bot; @name -> only the named bot(s).
// The mention must not follow an ASCII word character, so "user@claude.com"
// is not a mention, while "请@claude看看" is.
const MENTION = /(?<![A-Za-z0-9_.+-])[@＠]([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)/g;

export function resolveTargets(content: string, bots: readonly string[]): string[] {
  const mentioned = new Set<string>();
  for (const match of content.matchAll(MENTION)) {
    const name = match[1].toLowerCase();
    if (name === 'all') return [...bots];
    const bot = bots.find(candidate => candidate.toLowerCase() === name);
    if (bot) mentioned.add(bot);
  }
  // Unknown names are ignored; a message that names no known bot goes to everyone.
  return mentioned.size ? bots.filter(bot => mentioned.has(bot)) : [...bots];
}
