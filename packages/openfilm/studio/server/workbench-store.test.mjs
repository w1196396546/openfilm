import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { filmHtml } from '../../src/film-doc.mjs';
import { duplicateProject, openProject } from './projects.mjs';
import { closeWorkbench, listVideos, openWorkbench, patchVideo, transaction, WORKBENCH_ACCOUNT } from './workbench-store.mjs';

let scratch;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'of-workbench-')));
  process.env.OPENFILM_HOME = join(scratch, 'home');
  process.env.OPENFILM_LIBRARY = join(scratch, 'library');
  delete process.env.OPENFILM_SHARED_HOME;
});

afterEach(async () => {
  await closeWorkbench();
  await rm(scratch, { recursive: true, force: true });
});

test('the workbench opens in WAL, migrates once, and rolls back a failed batch', async () => {
  const db = await openWorkbench();
  assert.equal(await openWorkbench(), db);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('SELECT version FROM meta WHERE account_id = ?').get(WORKBENCH_ACCOUNT).version, 2);
  assert.deepEqual(await listVideos(db), []);
  assert.throws(() => transaction(db, () => {
    db.prepare('INSERT INTO runs (account_id, id, job, started_at) VALUES (?, ?, ?, ?)').run(WORKBENCH_ACCOUNT, 'test', 'test', 1);
    throw new Error('no write');
  }), /no write/);
  await closeWorkbench();
  const reopened = await openWorkbench();
  assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0);
  assert.equal(reopened.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('Studio and CLI can initialize the same fresh database concurrently', async () => {
  const run = promisify(execFile);
  const module = new URL('./workbench-store.mjs', import.meta.url).href;
  const script = `import { openWorkbench, closeWorkbench } from ${JSON.stringify(module)};
    if (!(await openWorkbench())) process.exitCode = 1;
    await closeWorkbench();`;
  await Promise.all(Array.from({ length: 8 }, () => run(process.execPath, ['--input-type=module', '-e', script], { timeout: 15_000 })));
  assert.equal((await openWorkbench()).prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('folder discovery, concurrent production patches, and append-only history through a project move', async () => {
  const db = await openWorkbench();
  const folder = join(process.env.OPENFILM_LIBRARY, 'First');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'film.html'), '<html></html>');
  const [initial] = await listVideos(db);
  assert.equal(initial.status, 'idea');
  assert.equal(initial.title, 'First');
  assert.equal(initial.hasPoster, false);
  await writeFile(join(folder, 'film.html'), filmHtml({ stage: { w: 1920, h: 1080 }, tracks: [{ clips: [{ id: 'hero', src: 'hero.png', time: [0, 3] }] }] }));
  const [uncached] = await listVideos(db);
  assert.equal(uncached.durationS, null);
  assert.equal(uncached.hasPoster, true);
  const file = join(folder, '.film', 'production.json');
  await writeFile(file, JSON.stringify({ futureField: 'keep' }));
  const now = Date.now();
  const day = 86_400_000;
  const publishedAt = now - 10 * day;
  await Promise.all([
    patchVideo(db, initial.id, { status: 'published', platform: 'douyin', publishedAt, videoUrl: 'https://www.douyin.com/video/123' }),
    patchVideo(db, initial.id, { tags: ['剪辑', ' 剪辑 ', '教程'] }),
  ]);
  const production = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(production.futureField, 'keep');
  assert.equal(production.status, 'published');
  assert.deepEqual(production.tags, ['剪辑', '教程']);
  await assert.rejects(patchVideo(db, initial.id, { videoUrl: 'javascript:alert(1)', status: 'idea' }), { status: 400 });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), production);

  const add = db.prepare('INSERT INTO snapshots (account_id, video_id, platform, captured_at, views, source) VALUES (?, ?, ?, ?, ?, ?)');
  transaction(db, () => {
    add.run(WORKBENCH_ACCOUNT, initial.id, 'douyin', now - 8 * day, 12, 'manual');
    add.run(WORKBENCH_ACCOUNT, initial.id, 'douyin', now - day, 42, 'manual');
    add.run(WORKBENCH_ACCOUNT, initial.id, 'xiaohongshu', now, 100, 'manual');
  });
  const moved = join(process.env.OPENFILM_LIBRARY, 'Moved');
  await rename(folder, moved);
  const [video] = await listVideos(db);
  assert.equal(video.id, initial.id);
  assert.equal(video.projectPath, moved);
  assert.equal(video.title, 'Moved');
  assert.equal(video.status, 'published');
  assert.equal(video.latestSnapshot.views, 42);
  assert.equal(video.recentViews, 30);
  const copied = await duplicateProject(video.id, 'Copy');
  assert.notEqual(copied.id, video.id);
  const copiedVideo = (await listVideos(db)).find((v) => v.id === copied.id);
  assert.equal(copiedVideo.status, 'published');
  assert.equal(copiedVideo.latestSnapshot, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM snapshots').get().n, 3);
});

test('a broken production record stays untouched and a missing project keeps its indexed data', async () => {
  const db = await openWorkbench();
  const project = await openProject(join(scratch, 'External'));
  await patchVideo(db, project.id, { status: 'ready' });
  const file = join(project.path, '.film', 'production.json');
  await writeFile(file, '{');
  assert.equal((await listVideos(db))[0].status, 'ready');
  await assert.rejects(patchVideo(db, project.id, { status: 'published' }), { status: 409 });
  assert.equal(await readFile(file, 'utf8'), '{');
  await rename(project.path, join(scratch, 'Unavailable'));
  const [video] = await listVideos(db);
  assert.equal(video.missing, true);
  assert.equal(video.status, 'ready');
  await assert.rejects(patchVideo(db, project.id, { status: 'published' }), { status: 410 });
});
