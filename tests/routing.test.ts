import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargets } from '../src/routing.ts';

const bots = ['claude', 'chatgpt'];

test('no mention and @all go to every bot', () => {
  assert.deepEqual(resolveTargets('大家怎么看', bots), bots);
  assert.deepEqual(resolveTargets('@all 大家怎么看', bots), bots);
  assert.deepEqual(resolveTargets('@claude 和 @ALL 都说说', bots), bots);
});

test('a mention selects only the named bot', () => {
  assert.deepEqual(resolveTargets('@claude 你怎么看', bots), ['claude']);
  assert.deepEqual(resolveTargets('@chatgpt 把这个记进公共记忆', bots), ['chatgpt']);
  assert.deepEqual(resolveTargets('请@Claude看看 ChatGPT 刚才说的', bots), ['claude']);
  assert.deepEqual(resolveTargets('＠claude你怎么看', bots), ['claude']);
});

test('several mentions select those bots in configured order, without duplicates', () => {
  assert.deepEqual(resolveTargets('@chatgpt @claude @chatgpt 一起看', bots), bots);
});

test('email addresses and unknown names are not mentions', () => {
  assert.deepEqual(resolveTargets('发到 me@claude.com', bots), bots);
  assert.deepEqual(resolveTargets('@claudette 你好', bots), bots);
  assert.deepEqual(resolveTargets('@gemini 和 @claude', bots), ['claude']);
});
