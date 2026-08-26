import assert from 'node:assert/strict';
import test from 'node:test';
import { shortSessionId } from '../lib/session-id.js';
import { visibleSidebarSessionIds } from '../lib/sidebar-order.js';

test('shortSessionId matches the QQ short form', () => {
  assert.equal(shortSessionId('session-7e13b62c-1234-5678'), '7e13b62c');
  assert.equal(shortSessionId('252de13c-1234-5678'), '252de13c');
});

test('visibleSidebarSessionIds follows workspace order and filters hidden rows', () => {
  const byId = {
    a: { id: 'a', displayTitle: 'same', blank: false, updatedAt: 3 },
    b: { id: 'b', displayTitle: 'same', blank: false, updatedAt: 2 },
    blank: { id: 'blank', displayTitle: 'New Session', blank: true, updatedAt: 4 },
    child: { id: 'child', displayTitle: 'child', blank: false, origin: 'subagent', updatedAt: 5 },
  };
  const list = { ids: ['a', 'b', 'blank', 'child'], byId, current: 'a' };
  const workspaces = [{ workspaceId: 'w', sessionIds: ['a', 'b', 'blank', 'child'] }];
  const view = {
    groupBy: 'workspace',
    groupExpansion: { w: true },
    sessionOrderByAccount: { w: ['b', 'a', 'blank', 'child'] },
  };
  assert.deepEqual(visibleSidebarSessionIds(list, workspaces, [], view), ['b', 'a']);
});
