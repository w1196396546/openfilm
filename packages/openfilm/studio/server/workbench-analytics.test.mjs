import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addSnapshots, appendSnapshots, listSnapshots, milestoneSnapshots, weeklyReport } from './workbench-analytics.mjs';
import { closeWorkbench, openWorkbench, transaction, WORKBENCH_ACCOUNT } from './workbench-store.mjs';

const DAY = 86_400_000;
const publishedAt = Date.UTC(2026, 9, 20, 12);
const video = { id: 'a', platform: 'douyin', publishedAt };

async function fixture(t, publication = publishedAt) {
  const home = await mkdtemp(join(tmpdir(), 'openfilm-analytics-'));
  const previous = process.env.OPENFILM_HOME;
  process.env.OPENFILM_HOME = home;
  t.after(async () => {
    try { await closeWorkbench(); }
    finally {
      if (previous == null) delete process.env.OPENFILM_HOME;
      else process.env.OPENFILM_HOME = previous;
      await rm(home, { recursive: true, force: true });
    }
  });
  const db = await openWorkbench();
  assert.ok(db);
  db.prepare(`INSERT INTO videos (account_id, id, project_id, project_path, title, status, platform, tags, hook, duration_s, published_at, created_at)
    VALUES (?, ?, ?, '/film', 'Video | title', 'published', ?, '["coffee"]', 'Question', 24, ?, ?)`).run(
    WORKBENCH_ACCOUNT, video.id, video.id, video.platform, publication, publication - DAY,
  );
  return db;
}

test('manual snapshots preserve zero, unknown metrics, the platform, and the first source', async (t) => {
  const db = await fixture(t);
  const snapshot = { capturedAt: '2026-10-21T20:00:00+08:00', views: 0, followersDelta: -1 };
  const first = addSnapshots(db, video, snapshot);
  assert.equal(first.added, 1);
  assert.deepEqual({ ...first.snapshots[0] }, { ...snapshot, capturedAt: publishedAt + DAY, platform: 'douyin',
    likes: null, comments: null, shares: null, saves: null, source: 'manual' });
  assert.equal(appendSnapshots(db, video, [snapshot], 'douyin').added, 0);
  assert.equal(listSnapshots(db, video).snapshots[0].source, 'manual');
  assert.throws(() => addSnapshots(db, video, { ...snapshot, platform: 'xiaohongshu' }), { status: 400 });
  assert.throws(() => addSnapshots(db, video, { ...snapshot, capturedAt: '2026-02-30T00:00Z' }), { status: 400 });
  assert.throws(() => addSnapshots(db, video, { ...snapshot, capturedAt: '2026-10-21T20:00:00' }), { status: 400 });
  assert.throws(() => addSnapshots(db, video, { ...snapshot, views: 1.5 }), { status: 400 });
  assert.throws(() => addSnapshots(db, video, { capturedAt: snapshot.capturedAt }), { status: 400 });
});

test('CSV imports quoted and empty fields atomically, deduplicates exact retries and rolls back conflicts', async (t) => {
  const db = await fixture(t);
  const csv = '\uFEFFcaptured_at,views,likes,followers_delta\r\n"2026-10-23T12:00Z",10,,\r\n"2026-10-27T12:00Z",12,5,-2\r\n';
  const first = addSnapshots(db, video, { csv });
  assert.equal(first.added, 2);
  assert.equal(first.snapshots[0].likes, null);
  assert.equal(first.snapshots[1].followersDelta, -2);
  assert.equal(addSnapshots(db, video, { csv }).added, 0);
  assert.throws(() => addSnapshots(db, video, { csv: 'capturedAt,views\n2026-10-28T12:00Z,99\n2026-10-27T12:00Z,123' }), { status: 409 });
  assert.throws(() => addSnapshots(db, video, { csv: 'capturedAt,views\n2026-10-28T12:00Z,99\n2026-10-29T12:00Z,oops' }), { status: 400 });
  assert.throws(() => addSnapshots(db, video, { csv: 'capturedAt,views\n"2026-10-28T12:00Z,99' }), { status: 400 });
  assert.throws(() => addSnapshots(db, video, { csv, platform: 'xiaohongshu' }), { status: 409 });
  assert.throws(() => transaction(db, () => {
    appendSnapshots(db, video, [{ capturedAt: publishedAt + DAY, likes: 4 }], 'douyin', { atomic: false });
    throw new Error('abort creator batch');
  }), /abort creator batch/);
  assert.equal(listSnapshots(db, video).snapshots.length, 2);
});

test('elapsed milestones use only observations from the preceding day', () => {
  const rows = [publishedAt - 1, publishedAt + DAY - 5, publishedAt + DAY, publishedAt + 2 * DAY - 1, publishedAt + 7 * DAY + 1]
    .map((capturedAt, views) => ({ capturedAt, views }));
  assert.deepEqual(milestoneSnapshots(rows, publishedAt, publishedAt + 8 * DAY).map(({ snapshot }) => snapshot?.views ?? null), [2, null, null]);
  assert.deepEqual(milestoneSnapshots(rows, publishedAt, publishedAt + DAY - 1).map(({ snapshot }) => snapshot), [null, null, null]);
});

test('weekly report shows measured change and T+7 group sample sizes', async (t) => {
  const now = publishedAt + 14 * DAY - 1;
  const db = await fixture(t);
  appendSnapshots(db, video, [
    { capturedAt: publishedAt + 7 * DAY - 5, views: 250, likes: 50 },
    { capturedAt: publishedAt + 12 * DAY, views: 300, likes: 60 },
  ], 'manual');
  const { markdown } = weeklyReport(db, now);
  assert.match(markdown, /Video \\\| title .*\| 300 \| 60 .*\| 50 \|/);
  assert.match(markdown, /Question × \\<30 秒 × .* × coffee \| 1 \| 250 \|/);
});
