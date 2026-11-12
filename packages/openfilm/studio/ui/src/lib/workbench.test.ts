import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateTimeInput, productionPatch, type Video } from './workbench.ts';

test('editing one field preserves unchanged timestamps and other production fields', () => {
  const video = {
    status: 'scheduled', platform: 'douyin', videoUrl: null, hook: null, tags: ['教程', 'AI'],
    scheduledAt: new Date(2026, 10, 12, 8, 23, 41).getTime(), publishedAt: null,
  } as Video;
  const form = new FormData();
  form.set('status', video.status);
  form.set('platform', 'douyin');
  form.set('scheduledAt', dateTimeInput(video.scheduledAt));
  form.set('tags', '教程，AI,教程');
  assert.equal(form.get('scheduledAt'), '2026-11-12T08:23');
  assert.deepEqual(productionPatch(video, form), {});
  const legacyTags = { ...video, tags: ['Tutorial, AI'] };
  form.set('tags', legacyTags.tags.join(', '));
  assert.deepEqual(productionPatch(legacyTags, form), {});

  form.set('tags', video.tags.join(', '));
  form.set('publishedAt', '2026-11-13T08:00');
  form.set('status', 'published');
  form.set('scheduledAt', '');
  assert.deepEqual(productionPatch(video, form), {
    status: 'published', scheduledAt: null, publishedAt: new Date(2026, 10, 13, 8).getTime(),
  });
});
