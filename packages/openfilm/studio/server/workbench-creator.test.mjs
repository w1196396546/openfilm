import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright-core';
import { createWorkbenchCreator, creatorMatches, creatorPagePath, creatorTime, visibleCreatorTables } from './workbench-creator.mjs';
import { openProject } from './projects.mjs';
import { closeWorkbench, openWorkbench, patchVideo } from './workbench-store.mjs';

const DAY = 86_400_000;
const first = Date.parse('2026-11-12T00:10:00.000Z');
const douyinUrl = 'https://www.douyin.com/video/7467283829123482222';
const xiaohongshuUrl = 'https://www.xiaohongshu.com/explore/6902d19d0000000007011ec1';
const dashboard = 'https://creator.douyin.com/creator-micro/data/content';
const row = (link, views = '1,200') => ({ links: [link], cells: ['作品', views, '52', '1.2万', '-1'] });
const table = (rows) => ({ headers: ['标题', '累计播放量', '累计获赞量', '累计评论数', '累计净增粉丝'], rows });

test('creator pages and clocks use the first-party origin and China time', () => {
  assert.deepEqual(creatorTime(new Date('2026-11-11T23:59:00Z')), { day: '2026-11-12', due: false });
  assert.deepEqual(creatorTime(first), { day: '2026-11-12', due: true });
  assert.equal(creatorPagePath('douyin', dashboard + '?temporary=secret'), '/creator-micro/data/content');
  assert.equal(creatorPagePath('douyin', 'https://creator.douyin.com.example.test/creator-micro/data'), null);
  assert.equal(creatorPagePath('douyin', 'https://creator.douyin.com@127.0.0.1/creator-micro/data'), null);
  assert.equal(creatorPagePath('douyin', 'https://creator.douyin.com/creator-micro/data/12345'), null);
});

test('only exact canonical IDs, cumulative counts, and unambiguous active projects are imported', () => {
  const video = { id: 'film', platform: 'douyin', videoUrl: douyinUrl + '?source=share', publishedAt: first - DAY };
  const second = { id: 'note', platform: 'xiaohongshu', videoUrl: xiaohongshuUrl, publishedAt: first - DAY };
  const shaped = creatorMatches('douyin', [table([
    row(douyinUrl + '?from=studio'), row(douyinUrl.replace('douyin.com', 'douyin.com.example.test')), row(xiaohongshuUrl),
  ])], [video, second], first);
  assert.deepEqual(shaped, { supported: true, matches: [{ video, sample: {
    capturedAt: first, views: 1200, likes: 52, comments: null, followersDelta: -1,
  } }] });
  assert.equal(creatorMatches('xiaohongshu', [{ ...table([row(xiaohongshuUrl)]), headers: ['标题', '累计阅读量', '获赞量', '评论数', '净增粉丝'] }], [second], first).matches.length, 1);
  assert.equal(creatorMatches('douyin', [table([row(douyinUrl)])], [video, { ...video, id: 'copy' }], first).matches.length, 0);
  assert.equal(creatorMatches('douyin', [table([row(douyinUrl), row(douyinUrl)])], [video], first).matches.length, 0);
  assert.equal(creatorMatches('douyin', [table([row(douyinUrl, '1.2万')])], [video], first).matches.length, 0);
  assert.equal(creatorMatches('douyin', [{ ...table([row(douyinUrl)]), headers: ['标题', '近7天播放量', '获赞量', '评论数', '净增粉丝'] }], [video], first).supported, false);
  assert.deepEqual(creatorMatches('douyin', [{ ...table([row(douyinUrl)]), headers: ['标题', '累计播放量', '获赞量', '评论数', '净增粉丝'] }], [video], first).matches[0].sample, {
    capturedAt: first, views: 1200,
  });
});

test('a rendered fixture exposes only linked rows and suppresses a visible sign-in challenge', async (t) => {
  let browser;
  try { browser = await chromium.launch(); }
  catch (error) {
    if (/executable doesn't exist/i.test(String(error))) return t.skip('Playwright test browser is not installed');
    throw error;
  }
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<h2>作品分析</h2><table><tr><th>作品</th><th>累计播放量</th></tr>
    <tr><td><a href="${douyinUrl}">样例</a></td><td>100</td></tr>
    <tr hidden><td><a href="${douyinUrl}">不可见</a></td><td>900</td></tr>
    <tr><td>没有链接</td><td>1234</td></tr></table>`);
  assert.deepEqual(await page.evaluate(visibleCreatorTables, ['作品分析']), {
    blocked: false, tables: [{ headers: ['作品', '累计播放量'], rows: [{ cells: ['样例', '100'], links: [douyinUrl] }] }],
  });
  await page.evaluate(() => { document.body.insertAdjacentHTML('beforeend', '<div role="dialog">请完成安全验证</div>'); });
  assert.deepEqual(await page.evaluate(visibleCreatorTables, ['作品分析']), { blocked: true, tables: [] });
});

async function request(creator, db, ...parts) {
  let answer;
  const req = { method: parts.length ? 'POST' : 'GET' };
  const res = { writeHead: () => {}, end: (body) => { answer = JSON.parse(body).sources[0]; } };
  await creator.route(req, res, parts, db);
  return answer;
}

test('setup and daily sync append once; a challenge disables the source and retains prior data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'of-creator-'));
  process.env.OPENFILM_HOME = join(root, 'home');
  process.env.OPENFILM_LIBRARY = join(root, 'library');
  delete process.env.OPENFILM_SHARED_HOME;
  const db = await openWorkbench();
  if (!db) { await rm(root, { recursive: true, force: true }); return t.skip('SQLite unavailable'); }
  let creator;
  t.after(async () => {
    await creator?.close();
    await closeWorkbench();
    await rm(root, { recursive: true, force: true });
  });
  const project = await openProject(join(root, 'My film'));
  await patchVideo(db, project.id, { platform: 'douyin', status: 'published', videoUrl: douyinUrl, publishedAt: first - DAY });

  let now = first;
  let currentUrl = 'about:blank';
  let blocked = false;
  let launches = 0;
  const visits = [];
  const options = {
    clock: () => now,
    launch: async () => {
      launches++;
      currentUrl = 'about:blank';
      const page = {
        url: () => currentUrl,
        bringToFront: async () => {},
        goto: async (url) => { visits.push(url); currentUrl = url; },
        waitForFunction: async () => ({ jsonValue: async () => ({ blocked, tables: [table([row(douyinUrl)])] }) }),
      };
      return { pages: () => [page], on: () => {}, close: async () => {} };
    },
  };
  creator = createWorkbenchCreator(options);
  assert.equal((await request(creator, db)).health, 'off');
  assert.equal(launches, 0);
  assert.equal((await request(creator, db, 'douyin', 'open')).setupOpen, true);
  currentUrl = dashboard;
  assert.equal((await request(creator, db, 'douyin', 'connect')).health, 'ok');
  assert.equal(launches, 1);
  assert.equal(db.prepare('SELECT views FROM snapshots').get().views, 1200);

  async function scheduled(health) {
    await creator.close();
    now += DAY;
    const stopped = Promise.withResolvers();
    creator = createWorkbenchCreator({ ...options, changed: () => {
      const current = db.prepare("SELECT health, last_run_at FROM creator_sources WHERE platform = 'douyin'").get();
      if (current?.health === health && current.last_run_at === now) stopped.resolve();
    } });
    creator.start();
    await stopped.promise;
  }
  await scheduled('ok');
  assert.equal(visits.at(-1), dashboard);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, 2);
  blocked = true;
  await scheduled('unavailable');
  const after = await request(creator, db);
  assert.equal(after.enabled, false);
  assert.equal(after.health, 'unavailable');
  assert.equal(after.attemptedToday, true);
  assert.equal(visits.at(-1), dashboard);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, 2);
  assert.deepEqual(db.prepare('SELECT ok FROM runs ORDER BY started_at').all().map((run) => run.ok), [1, 1, 0]);
  await request(creator, db, 'douyin', 'open');
  currentUrl = dashboard;
  await assert.rejects(request(creator, db, 'douyin', 'connect'), (error) => error.extra?.code === 'onceDaily');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM snapshots').get().count, 2);
  assert.equal((await request(creator, db, 'douyin', 'disable')).health, 'off');
});
