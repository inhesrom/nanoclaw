import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGrokJsonOutput } from './grok-runtime.js';

test('parseGrokJsonOutput reads text and sessionId from success JSON', () => {
  const out = parseGrokJsonOutput(
    JSON.stringify({
      text: 'Hello from Grok',
      sessionId: 'sess-123',
      stopReason: 'end_turn',
    }),
  );
  assert.equal(out.result, 'Hello from Grok');
  assert.equal(out.sessionId, 'sess-123');
});

test('parseGrokJsonOutput prefers the last JSON line when banners precede it', () => {
  const out = parseGrokJsonOutput(
    `Checking for updates...\n${JSON.stringify({ text: 'done', sessionId: 'abc' })}`,
  );
  assert.equal(out.result, 'done');
  assert.equal(out.sessionId, 'abc');
});

test('parseGrokJsonOutput throws on error objects', () => {
  assert.throws(
    () =>
      parseGrokJsonOutput(
        JSON.stringify({ type: 'error', message: 'auth failed' }),
      ),
    /auth failed/,
  );
});

test('parseGrokJsonOutput falls back to plain text when not JSON', () => {
  const out = parseGrokJsonOutput('just a plain reply');
  assert.equal(out.result, 'just a plain reply');
  assert.equal(out.sessionId, undefined);
});
