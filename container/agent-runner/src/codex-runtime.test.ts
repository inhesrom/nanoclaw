import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractCodexJsonError,
  formatCodexExitError,
} from './codex-runtime.js';

test('formatCodexExitError prefers a JSON error over noisy stderr', () => {
  const message = formatCodexExitError(
    1,
    'Reading additional input from stdin...\n(node:43) [UNDICI-EHPA] Warning',
    'Unknown model: sol',
  );
  assert.equal(message, 'codex exited with code 1: Unknown model: sol');
});

test('formatCodexExitError ignores Codex stdin/undici noise', () => {
  const message = formatCodexExitError(
    1,
    '(node:43) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental\nReading additional input from stdin...',
  );
  assert.equal(message, 'codex exited with code 1');
});

test('formatCodexExitError redacts proxy credentials in stderr', () => {
  const message = formatCodexExitError(
    1,
    'proxy http://x:aoc_secretvalue@host.docker.internal:10255 failed',
  );
  assert.match(message, /codex exited with code 1:/);
  assert.doesNotMatch(message, /aoc_secretvalue/);
  assert.match(message, /\[REDACTED\]/);
});

test('extractCodexJsonError reads error events', () => {
  assert.equal(
    extractCodexJsonError({ type: 'error', message: 'unknown model sol' }),
    'unknown model sol',
  );
  assert.equal(extractCodexJsonError({ type: 'turn.completed' }), undefined);
});
