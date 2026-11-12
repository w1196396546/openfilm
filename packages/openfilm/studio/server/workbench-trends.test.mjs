import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorkbenchTrends } from './workbench-trends.mjs';
import { closeWorkbench, openWorkbench } from './workbench-store.mjs';
import { hotTopicId, scoreHotTopics } from './workbench-score.mjs';

const EAST = '2026-11-12T07:59:00+08:00';
const MIN = 60_000;
const douyin = (time) => ({
  status_code: 0, active_time: time, extra: { now: Date.parse(EAST) },
  word_list: [{ word: '制作咖啡 <at user_id="all">', hot_value: 12000 }, { word: '新车展消息', hot_value: 4000 }],
});
const baidu = () => ({
  success: true,
  data: { cards: [{ component: 'hotList', content: [{ word: '制作咖啡 <at user_id="all">', hotScore: '9000' }, { word: '山景摄影', hotScore: '8000' }] }] },
});

async function temporaryHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'workbench-trends-'));
  const names = ['OPENFILM_HOME', 'OPENFILM_FEISHU_WEBHOOK', 'OPENFILM_WECOM_WEBHOOK',
    'OPENFILM_NEWSNOW_ORIGIN', 'OPENFILM_DAILYHOT_ORIGIN'];
  const original = names.map((name) => [name, process.env[name]]);
  for (const name of names) delete process.env[name];
  process.env.OPENFILM_HOME = home;
  t.after(async () => {
    await closeWorkbench();
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

test('expired hot data is displayed separately and a healthy source keeps working through a failure', async (t) => {
  const stateDir = await temporaryHome(t);
  let time = Date.parse(EAST);
  let calls = 0;
  let baiduFailed = false;
  const trends = createWorkbenchTrends({
    stateDir, now: () => time,
    fetchFn: async (url) => {
      calls++;
      if (String(url).includes('iesdouyin')) return Response.json(douyin('2026-11-12 05:30:00'));
      return baiduFailed ? new Response('unavailable', { status: 503 }) : Response.json(baidu());
    },
  });
  assert.equal((await trends.read()).generatedAt, null);
  const first = await trends.refresh();
  assert.equal(first.date, '2026-11-12');
  assert.deepEqual(first.sources.map((source) => source.status), ['stale', 'fresh']);
  assert.equal(first.sources[0].updatedAt, '2026-11-11T21:30:00.000Z');
  assert.equal(first.sources[1].updatedAt, null);
  assert.equal(first.sources[1].fetchedAt, new Date(time).toISOString());
  assert.equal(first.sources[0].items.length, 2);
  assert.ok(first.topics.length);
  assert.ok(first.topics.every((topic) => topic.source === 'baidu'));
  assert.equal((await trends.refresh()).topics.length, first.topics.length);
  assert.equal(calls, 2, 'manual refreshes share the 45-minute cache');
  time += 91 * MIN;
  assert.equal((await trends.read()).sources[1].status, 'stale');
  baiduFailed = true;
  assert.deepEqual((await trends.refresh()).sources.map((source) => source.status), ['stale', 'unavailable']);
  assert.deepEqual((await trends.read()).topics, []);
  assert.equal((await trends.read()).sources[1].items.length, 2, 'a failed request keeps the last cached chart');
  await trends.updateSettings({ sources: { baidu: false } });
  assert.equal((await trends.read()).sources[1].status, 'disabled');
  assert.equal((await trends.read()).sources[1].items.length, 0);
});

test('Shanghai schedule deduplicates delivery across Studio instances and logs a rejected webhook once', async (t) => {
  const stateDir = await temporaryHome(t);
  let time = Date.parse(EAST);
  const sent = [];
  const webhook = {
    feishu: 'https://open.feishu.cn/open-apis/bot/v2/hook/fake-00000000',
    wecom: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=fake-11111111',
  };
  const options = {
    stateDir, now: () => time, workbenchUrl: () => 'http://127.0.0.1:4747/workbench',
    fetchFn: async (url, init) => {
      if (init.method === 'POST') {
        sent.push({ url: String(url), body: JSON.parse(init.body), redirect: init.redirect });
        return Response.json(String(url).includes('feishu') ? { code: 0 } : { errcode: 40001 });
      }
      return Response.json(String(url).includes('iesdouyin') ? douyin('2026-11-12 07:50:00') : baidu());
    },
  };
  const trends = createWorkbenchTrends(options);
  await assert.rejects(trends.updateSettings({ webhooks: { feishu: 'https://open.feishu.cn.evil.test/open-apis/bot/v2/hook/fake-00000000' } }), /valid Feishu/);
  const settings = await trends.updateSettings({ webhooks: webhook });
  assert.deepEqual(settings.webhooks.feishu, { configured: true, fromEnv: false, last4: '0000' });
  assert.deepEqual(settings.webhooks.wecom, { configured: true, fromEnv: false, last4: '1111' });
  assert.ok(!JSON.stringify(settings).includes('fake-'));
  process.env.OPENFILM_FEISHU_WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/env-22222222';
  assert.deepEqual((await trends.settings()).webhooks.feishu, { configured: true, fromEnv: true, last4: '2222' });
  delete process.env.OPENFILM_FEISHU_WEBHOOK;
  const file = join(stateDir, 'workbench-providers.json');
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok((await readFile(file, 'utf8')).includes(webhook.feishu));

  await trends.tick();
  const manual = await trends.refresh();
  assert.equal(sent.length, 0);
  assert.equal(manual.topics.filter((topic) => topic.id === hotTopicId('制作咖啡 <at user_id="all">')).length, 1);
  time += MIN;
  await Promise.all([trends.tick(), createWorkbenchTrends(options).tick()]);
  await createWorkbenchTrends(options).tick();
  assert.equal(sent.length, 2);
  const feishu = sent.find(({ url }) => url === webhook.feishu);
  const wecom = sent.find(({ url }) => url === webhook.wecom);
  assert.equal(feishu.redirect, 'error');
  assert.equal(feishu.body.msg_type, 'post');
  assert.doesNotMatch(JSON.stringify(feishu.body), /<at/);
  assert.match(JSON.stringify(feishu.body), /openfilm:\/\/topic\/hot-[a-f0-9]{24}/);
  assert.equal(wecom.body.msgtype, 'markdown');
  assert.match(wecom.body.markdown.content, /127\.0\.0\.1:4747\/workbench/);
  assert.deepEqual((await trends.read()).deliveries, {
    feishu: { status: 'sent', error: null },
    wecom: { status: 'failed', error: 'Webhook did not accept the message' },
  });
});

test('own high-performing Douyin work and freshness affect ranking', async () => {
  const now = Date.parse(EAST);
  const candidate = (title, time = now) => ({ id: hotTopicId(title), title, url: null, heat: 100, rank: 2,
    source: 'douyin', firstSeen: time, popularity: 0.85, referenceCount: 0 });
  const video = (title, views, platform = 'douyin') => ({
    title, platform, tags: ['咖啡'], durationS: 28, publishedAt: now - 10_000, latestSnapshot: { views },
  });
  const { topics } = await scoreHotTopics([
    candidate('旅行新闻'), candidate('咖啡制作教程'), candidate('过期的话题', now - 24 * 60 * MIN),
  ], [video('咖啡制作教程', 1000), video('随手剪辑', 30), video('旅行新闻', 2000, 'xiaohongshu')], now);
  assert.equal(topics.length, 2);
  assert.equal(topics[0].title, '咖啡制作教程');
  assert.match(topics[0].reason, /高表现作品/);
  assert.match(topics[0].format, /约 28 秒步骤演示/);
});


test('stopping aborts an active refresh and waits for the daily claim to finish without emitting updates', async (t) => {
  const stateDir = await temporaryHome(t);
  let changed = 0;
  let begin;
  const began = new Promise((resolve) => { begin = resolve; });
  const trends = createWorkbenchTrends({
    stateDir, now: () => Date.parse(EAST) + MIN, onChange: () => { changed++; },
    fetchFn: async (_url, { signal }) => {
      begin();
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const checking = trends.tick();
  await began;
  await trends.stop();
  assert.equal(changed, 0);
  const db = await openWorkbench();
  assert.equal(db.prepare("SELECT ok FROM runs WHERE id = 'daily:2026-11-12'").get().ok, 0);
  await checking;
});


test('configured mirrors follow direct sources, respect timestamps, and share the source cache', async (t) => {
  const stateDir = await temporaryHome(t);
  process.env.OPENFILM_NEWSNOW_ORIGIN = 'http://127.0.0.1:3444';
  process.env.OPENFILM_DAILYHOT_ORIGIN = 'https://hot.example.test';
  let time = Date.parse(EAST);
  let newsnowFresh = false;
  const calls = [];
  const trends = createWorkbenchTrends({
    stateDir, now: () => time,
    fetchFn: async (input, init) => {
      const url = new URL(input);
      calls.push(url.href);
      assert.equal(init.redirect, 'error');
      if (url.hostname === 'top.baidu.com') return Response.json(baidu());
      if (url.hostname === 'www.iesdouyin.com') return Response.json(douyin('2026-11-12 05:30:00'));
      if (url.hostname === '127.0.0.1') {
        return Response.json({ status: 'cache', id: 'douyin', updatedTime: newsnowFresh ? time : time - 91 * MIN,
          items: [{ title: '来自 NewsNow', url: 'https://other.example.test' }] });
      }
      return Response.json({ code: 200, name: 'douyin', updateTime: new Date(time).toISOString(),
        data: [{ title: '来自 DailyHotApi', hot: 1000, url: 'javascript:alert(1)' }] });
    },
  });
  const first = await trends.refresh();
  assert.equal(first.sources[0].via, 'dailyhot');
  assert.equal(first.sources[1].via, 'direct');
  assert.equal(first.sources[0].status, 'fresh');
  assert.equal(first.sources[0].items[0].heat, 1000);
  assert.match(first.sources[0].items[0].url, /^https:\/\/www\.douyin\.com\/search\//);
  assert.ok(first.topics.some(({ title }) => title === '来自 DailyHotApi'));
  assert.ok(first.topics.every(({ title }) => title !== '来自 NewsNow'));
  assert.deepEqual(calls.filter((url) => !url.includes('baidu.com')).slice(1),
    ['http://127.0.0.1:3444/api/s?id=douyin', 'https://hot.example.test/douyin']);
  await trends.refresh();
  assert.equal(calls.length, 4);
  time += 46 * MIN;
  newsnowFresh = true;
  assert.equal((await trends.refresh()).sources[0].via, 'newsnow');
  assert.equal(calls.length, 7, 'DailyHotApi is not called when NewsNow has a fresh chart');
});

test('fallback ignores non-origin or cleartext remote configuration', async (t) => {
  const stateDir = await temporaryHome(t);
  process.env.OPENFILM_NEWSNOW_ORIGIN = 'https://news.example.test/base';
  process.env.OPENFILM_DAILYHOT_ORIGIN = 'http://dailyhot.example.test';
  const calls = [];
  const trends = createWorkbenchTrends({
    stateDir, now: () => Date.parse(EAST),
    fetchFn: async (url) => { calls.push(String(url)); return new Response('unavailable', { status: 503 }); },
  });
  const result = await trends.refresh();
  assert.deepEqual(result.sources.map(({ status }) => status), ['unavailable', 'unavailable']);
  assert.deepEqual(calls.map((url) => new URL(url).hostname), ['www.iesdouyin.com', 'top.baidu.com']);
});
