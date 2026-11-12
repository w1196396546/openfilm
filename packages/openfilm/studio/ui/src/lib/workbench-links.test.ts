import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workbenchLink } from './workbench-links.ts';

test('workbench feed and reference links accept only absolute HTTP(S) URLs without credentials', () => {
  assert.equal(workbenchLink('https://example.com/video'), 'https://example.com/video');
  for (const url of [null, '/video', '//example.com', 'file:///tmp/video', 'javascript:alert(1)', 'https://name:secret@example.com']) {
    assert.equal(workbenchLink(url), null);
  }
});
