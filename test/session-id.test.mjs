import assert from 'node:assert/strict';
import test from 'node:test';
import { shortSessionId } from '../lib/session-id.js';

test('shortSessionId matches the QQ short form', () => {
  assert.equal(shortSessionId('session-7e13b62c-1234-5678'), '7e13b62c');
  assert.equal(shortSessionId('252de13c-1234-5678'), '252de13c');
});
