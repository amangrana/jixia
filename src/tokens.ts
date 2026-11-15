// "用字数估算": a CJK character is about one token, other text about four
// characters per token. Deliberately on the high side so limits refuse early.
export function estimateTokens(text: string): number {
  let wide = 0;
  for (const char of text) if (char.codePointAt(0)! >= 0x2e80) wide++;
  return wide + Math.ceil((text.length - wide) / 4);
}
