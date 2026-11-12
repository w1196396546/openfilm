import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startStudio } from './server.mjs';
import { closeWorkbench } from './workbench-store.mjs';

test('Studio and CLI share topic projects, portable production status and append-only metrics', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'of-workbench-'));
  process.env.OPENFILM_HOME = join(scratch, 'home');
  process.env.OPENFILM_LIBRARY = join(scratch, 'projects');
  const studio = await startStudio({ port: 0, advertise: true, openBrowser: () => {} });
  t.after(async () => {
    await studio.close();
    await closeWorkbench();
    await rm(scratch, { recursive: true, force: true });
  });
  const api = (path, method = 'GET', body, authenticated = true) => fetch(`${studio.origin}/api/workbench${path}`, {
    method, headers: {
      ...(authenticated ? { 'x-studio-key': studio.key } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ok = async (...args) => {
    const response = await api(...args);
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };

  assert.equal((await api('/videos', 'GET', undefined, false)).status, 401);
  const page = await fetch(`${studio.origin}/workbench?key=${studio.key}`);
  assert.equal(page.status, 200);
  const session = page.headers.getSetCookie()[0].split(';')[0];
  const otherOrigin = await fetch(`${studio.origin}/api/workbench/topics`, {
    method: 'POST', headers: { cookie: session, origin: 'https://example.org' },
    body: JSON.stringify({ title: 'cross-origin' }),
  });
  assert.equal(otherOrigin.status, 403);
  assert.deepEqual(await ok('/videos'), { videos: [] });
  assert.equal((await api('/topics', 'POST', { title: '' })).status, 400);
  const { topic } = await ok('/topics', 'POST', { title: '手工咖啡' });
  const { topic: other } = await ok('/topics', 'POST', { title: topic.title });
  const socket = new WebSocket(studio.origin.replace(/^http/, 'ws') + '/api/events', { headers: { 'x-studio-key': studio.key } });
  t.after(() => socket.close());
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const event = new Promise((resolve) => socket.addEventListener('message', (message) => resolve(JSON.parse(message.data)), { once: true }));
  const [{ video }, { video: repeated }, { video: different }] = await Promise.all([
    ok(`/topics/${topic.id}/start`, 'POST'), ok(`/topics/${topic.id}/start`, 'POST'), ok(`/topics/${other.id}/start`, 'POST'),
  ]);
  assert.deepEqual(await event, { type: 'workbench' });
  assert.equal(repeated.id, video.id);
  assert.notEqual(different.id, video.id);
  assert.equal((await ok(`/topics/${topic.id}`)).topic.projectId, video.id);
  assert.equal(video.topicId, topic.id);
  assert.equal((await ok('/videos')).videos.length, 2);
  assert.equal((await api('/references', 'POST', { topicId: topic.id, title: 'unsafe', platform: 'douyin', url: 'javascript:void(0)' })).status, 400);
  await ok('/references', 'POST', { topicId: topic.id, title: '参考', platform: 'douyin', url: 'https://example.org/video', breakdown: '前 3 秒展示成品。' });
  assert.equal((await ok('/references')).references[0].topicId, topic.id);

  const publishedAt = Date.now() - 3 * 86_400_000;
  await ok(`/videos/${video.id}`, 'PATCH', { status: 'published', platform: 'douyin', publishedAt, tags: ['咖啡'] });
  const production = JSON.parse(await readFile(join(video.projectPath, '.film', 'production.json'), 'utf8'));
  assert.equal(production.status, 'published');
  assert.equal(production.topicId, topic.id);
  const row = { capturedAt: publishedAt + 86_400_000, views: 700, likes: 18 };
  assert.equal((await ok(`/videos/${video.id}/snapshots`, 'POST', row)).added, 1);
  assert.equal((await ok(`/videos/${video.id}/snapshots`, 'POST', row)).added, 0);
  assert.equal((await ok(`/videos/${video.id}/snapshots`)).snapshots[0].views, 700);
  assert.match((await ok('/reports/weekly')).markdown, /手工咖啡/);

  const cli = fileURLToPath(new URL('../../bin/openfilm.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'workbench', 'video', 'stats', video.id, '--json']);
  assert.equal(JSON.parse(stdout).snapshots[0].views, 700);

  await studio.close();
  const backup = join(scratch, 'backup.db');
  await copyFile(join(process.env.OPENFILM_HOME, 'workbench.db'), backup);
  const { DatabaseSync } = await import('node:sqlite');
  const restored = new DatabaseSync(backup, { readOnly: true });
  try { assert.equal(restored.prepare('SELECT views FROM snapshots WHERE video_id = ?').get(video.id).views, 700); }
  finally { restored.close(); }
});
