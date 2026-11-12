import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { HttpError, json } from './http.mjs';
import { studioHome } from './projects.mjs';
import { appendSnapshots } from './workbench-analytics.mjs';
import { listVideos, openWorkbench, transaction, WORKBENCH_ACCOUNT } from './workbench-store.mjs';

const PORTALS = {
  douyin: {
    origin: 'https://creator.douyin.com',
    publicOrigin: /^https:\/\/(?:www\.)?douyin\.com$/,
    workPath: /^\/(?:video|note)\/(\d{12,24})\/?$/,
    headings: ['作品数据', '作品分析', '内容分析'],
  },
  xiaohongshu: {
    origin: 'https://creator.xiaohongshu.com',
    publicOrigin: /^https:\/\/(?:www\.)?xiaohongshu\.com$/,
    workPath: /^\/(?:explore|discovery\/item)\/([a-f\d]{24})\/?$/i,
    headings: ['笔记数据', '笔记分析', '作品数据'],
  },
};
const TIME = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});
const WINDOW_TIMEOUT = 15_000;

export function creatorTime(at) {
  const { year, month, day, hour } = Object.fromEntries(TIME.formatToParts(at).map(({ type, value }) => [type, value]));
  return { day: `${year}-${month}-${day}`, due: Number(hour) >= 8 };
}

function readUrl(value) {
  try { return new URL(value); } catch { return null; }
}

export function creatorPagePath(platform, value) {
  const url = readUrl(value);
  if (url?.origin !== PORTALS[platform].origin || url.username || url.password || url.hash) return null;
  return /^\/(?:[a-z][a-z0-9-]{0,31}(?:\/[a-z][a-z0-9-]{0,31}){0,7}\/?)?$/i.test(url.pathname) ? url.pathname : null;
}

function workId(platform, value) {
  const url = readUrl(value);
  return url && !url.username && !url.password && PORTALS[platform].publicOrigin.test(url.origin)
    ? PORTALS[platform].workPath.exec(url.pathname)?.[1].toLowerCase() : null;
}

const METRICS = {
  views: /^(?:总|累计)(?:播放量|播放次数|观看量|浏览量|阅读量)$/,
  likes: /^(?:总|累计)(?:获赞量|点赞量|点赞数|点赞)$/,
  comments: /^(?:总|累计)(?:评论量|评论数|评论)$/,
  shares: /^(?:总|累计)(?:分享量|分享数|转发量|转发数|分享|转发)$/,
  saves: /^(?:总|累计)(?:收藏量|收藏数|收藏)$/,
  followersDelta: /^(?:总|累计)(?:净增粉丝|净增粉丝数)$/,
};

function count(value, signed) {
  if (typeof value !== 'string') return null;
  const pattern = signed ? /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$/ : /^(?:\d+|\d{1,3}(?:,\d{3})+)$/;
  const normalized = value.normalize('NFKC').trim();
  if (!pattern.test(normalized)) return null;
  const number = Number(normalized.replaceAll(',', ''));
  return Number.isSafeInteger(number) ? number : null;
}

/** A supported table identifies every imported work by its canonical public link and has cumulative views. */
export function creatorMatches(platform, tables, videos, capturedAt) {
  const linked = new Map();
  for (const video of videos) {
    if (video.platform !== platform || video.missing || !video.publishedAt || video.publishedAt > capturedAt) continue;
    const id = workId(platform, video.videoUrl);
    if (id) linked.set(id, linked.has(id) ? null : video);
  }
  let supported = false;
  const matches = new Map();
  for (const { headers, rows } of tables) {
    const columns = Object.fromEntries(Object.entries(METRICS).map(([key, pattern]) => [
      key, headers.reduce((hits, label, index) => pattern.test(label) ? [...hits, index] : hits, []),
    ]));
    if (columns.views.length !== 1) continue;
    supported = true;
    for (const { links, cells } of rows) {
      const ids = new Set(links.map((url) => workId(platform, url)).filter(Boolean));
      if (ids.size !== 1 || cells.length !== headers.length) continue;
      const id = [...ids][0];
      const video = linked.get(id);
      if (!video) continue;
      const sample = { capturedAt };
      for (const [key, indices] of Object.entries(columns)) {
        if (indices.length === 1) sample[key] = count(cells[indices[0]], key === 'followersDelta');
      }
      if (sample.views === null) continue;
      // More than one row for the same ID can be a breakdown rather than one work's totals.
      matches.set(id, matches.has(id) ? null : { video, sample });
    }
  }
  return { supported, matches: [...matches.values()].filter(Boolean) };
}

/** Runs in the visible creator page. Read rendered tables only. */
export function visibleCreatorTables(headings) {
  const visible = (node) => !!node.getClientRects().length && node.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const text = (node) => (node.innerText ?? '').trim();
  const gate = Array.from(document.querySelectorAll('input[type=password], dialog[open], [role=dialog], iframe')).some((node) =>
    visible(node) && (node.tagName === 'INPUT' || /登录|验证码|安全验证|访问受限|captcha|sign in/i.test(text(node) + ' ' + node.getAttribute('title') + ' ' + node.getAttribute('src'))));
  if (gate) return { blocked: true, tables: [] };
  const pageHeading = Array.from(document.querySelectorAll('h1, h2, h3, [role=heading], [aria-selected=true], [aria-current=page]'))
    .some((node) => visible(node) && headings.includes(text(node)));
  if (!pageHeading) return null;

  const tableSelector = 'table, [role=table], [role=grid]';
  const rowSelector = 'tr, [role=row]';
  const cellSelector = 'th, td, [role=columnheader], [role=cell], [role=gridcell]';
  const tables = [];
  for (const table of Array.from(document.querySelectorAll(tableSelector)).filter(visible).slice(0, 8)) {
    const rendered = Array.from(table.querySelectorAll(rowSelector)).filter((row) => row.closest(tableSelector) === table && visible(row));
    const cells = (row) => Array.from(row.querySelectorAll(cellSelector)).filter((cell) => cell.closest(rowSelector) === row && visible(cell));
    const header = rendered.find((row) => cells(row).some((cell) => cell.matches('th, [role=columnheader]')));
    if (!header) continue;
    const rows = [];
    // shortcut: only rendered rows are supported; revisit when a verified portal offers a first-party export.
    for (const row of rendered.filter((row) => row !== header).slice(0, 100)) {
      const links = Array.from(row.querySelectorAll('a[href]')).filter(visible).slice(0, 20).map((link) => link.href);
      if (links.length) rows.push({ links, cells: cells(row).map(text) });
    }
    if (rows.length) tables.push({ headers: cells(header).map(text), rows });
  }
  return tables.length ? { blocked: false, tables } : null;
}

async function launchBrowser(platform) {
  const profile = join(studioHome(), 'creator-profiles', WORKBENCH_ACCOUNT, platform);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const options = { headless: false, chromiumSandbox: true, acceptDownloads: false, timeout: WINDOW_TIMEOUT, locale: 'zh-CN' };
  const channels = existsSync(chromium.executablePath()) ? ['chromium'] : ['chrome', 'msedge'];
  for (const channel of channels) {
    try { return await chromium.launchPersistentContext(profile, { ...options, channel }); }
    catch (error) {
      // A second browser is useful only if the first executable is absent.
      if (channel === channels.at(-1) || !/executable doesn't exist|distribution .* is not found/i.test(String(error))) throw error;
    }
  }
}

const available = (db, platform) =>
  db.prepare('SELECT * FROM creator_sources WHERE account_id = ? AND platform = ?').get(WORKBENCH_ACCOUNT, platform);
const ensure = (db, platform) =>
  db.prepare('INSERT OR IGNORE INTO creator_sources (account_id, platform) VALUES (?, ?)').run(WORKBENCH_ACCOUNT, platform);

export function createWorkbenchCreator({ changed = () => {}, launch = launchBrowser, clock = Date.now } = {}) {
  const windows = new Map();
  const active = new Map();
  let timer;
  let closed = false;
  let ticking = false;

  function status(db) {
    return Object.keys(PORTALS).map((platform) => {
      const source = available(db, platform);
      const health = source?.health ?? 'off';
      return {
        platform, enabled: source?.enabled === 1, setupOpen: windows.has(platform) && health === 'setup',
        health: health === 'reading' && clock() - source.last_run_at > 5 * 60_000 ? 'interrupted' : health,
        lastRunAt: source?.last_run_at ?? null, attemptedToday: source?.last_attempt_day === creatorTime(clock()).day,
      };
    });
  }

  async function openWindow(platform, signal) {
    const context = await launch(platform);
    if (signal.aborted || closed) {
      await context.close().catch(() => {});
      throw new Error('Creator browser closed');
    }
    windows.set(platform, context);
    context.on('close', () => {
      if (windows.get(platform) !== context) return;
      windows.delete(platform);
      changed();
    });
    return context;
  }

  async function closeWindow(platform) {
    const context = windows.get(platform);
    if (!context) return;
    windows.delete(platform);
    await context.close().catch(() => {});
  }

  async function operate(platform, fn) {
    if (active.has(platform) || closed) throw new HttpError(409, 'Creator source is busy or closing');
    const controller = new AbortController();
    const operation = Promise.resolve().then(() => fn(controller.signal));
    active.set(platform, { controller, operation });
    try { return await operation; }
    finally { active.delete(platform); }
  }

  async function openSetup(db, platform) {
    await operate(platform, async (signal) => {
      if (signal.aborted) return;
      ensure(db, platform);
      const setup = db.prepare("UPDATE creator_sources SET health = 'setup' WHERE account_id = ? AND platform = ? AND enabled = 0")
        .run(WORKBENCH_ACCOUNT, platform);
      if (!setup.changes) throw new HttpError(409, 'Disable the creator source before setting it up again');
      let failure = 'browser';
      try {
        const context = windows.get(platform) ?? await openWindow(platform, signal);
        const page = context.pages().at(-1) ?? await context.newPage();
        await page.bringToFront();
        if (page.url() === 'about:blank') {
          failure = 'unavailable';
          const response = await page.goto(PORTALS[platform].origin, { waitUntil: 'domcontentloaded', timeout: WINDOW_TIMEOUT });
          if (response && !response.ok()) throw new Error('Creator page unavailable');
        }
      } catch {
        if (!signal.aborted && !closed) db.prepare("UPDATE creator_sources SET health = ? WHERE account_id = ? AND platform = ? AND health = 'setup'")
          .run(failure, WORKBENCH_ACCOUNT, platform);
        await closeWindow(platform);
      }
      changed();
    });
  }

  async function sync(db, platform, manual = false) {
    await operate(platform, async (signal) => {
      if (signal.aborted) return;
      const at = clock();
      const { day } = creatorTime(at);
      const source = available(db, platform);
      if (manual && (!windows.has(platform) || source?.health !== 'setup')) throw new HttpError(409, 'Open the creator browser first');
      if (!manual && (source?.enabled !== 1 || source.health !== 'ok')) return;
      const job = `creator:${platform}`;
      const runId = `${job}:${day}`;
      const claimed = transaction(db, () => {
        const result = db.prepare(`UPDATE creator_sources SET health = 'reading', last_run_at = ?, last_attempt_day = ?
          WHERE account_id = ? AND platform = ? AND health = ? AND (last_attempt_day IS NULL OR last_attempt_day < ?)`)
          .run(at, day, WORKBENCH_ACCOUNT, platform, source.health, day);
        if (!result.changes) return false;
        db.prepare('INSERT INTO runs (account_id, id, job, started_at) VALUES (?, ?, ?, ?)')
          .run(WORKBENCH_ACCOUNT, runId, job, at);
        return true;
      });
      if (!claimed) {
        if (manual) throw new HttpError(409, 'This creator source has already attempted a sync today', { code: 'onceDaily' });
        return;
      }
      changed();
      const finish = db.prepare(`UPDATE creator_sources SET enabled = ?, health = ?, path = ?
        WHERE account_id = ? AND platform = ? AND health = 'reading' AND last_run_at = ? AND last_attempt_day = ?`);
      const endRun = db.prepare('UPDATE runs SET finished_at = ?, ok = ?, error = ?, result_json = ? WHERE account_id = ? AND id = ?');
      let failure = 'browser';
      try {
        const context = windows.get(platform) ?? await openWindow(platform, signal);
        const page = context.pages().at(-1) ?? await context.newPage();
        failure = 'unavailable';
        if (!manual) {
          const target = new URL(source.path, PORTALS[platform].origin).href;
          if (creatorPagePath(platform, target) !== source.path) throw new Error('Creator page changed');
          const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: WINDOW_TIMEOUT });
          if (response && !response.ok()) throw new Error('Creator page unavailable');
        }
        const path = creatorPagePath(platform, page.url());
        if (!path || (!manual && path !== source.path)) throw new Error('Creator page changed');
        failure = 'unsupported';
        const result = await page.waitForFunction(visibleCreatorTables, PORTALS[platform].headings, { timeout: 8_000, polling: 250 });
        const { blocked, tables } = await result.jsonValue();
        if (blocked) failure = 'unavailable';
        if (blocked || creatorPagePath(platform, page.url()) !== path) throw new Error('Creator page changed');
        failure = 'writeFailed';
        const videos = await listVideos(db);
        const { supported, matches } = creatorMatches(platform, tables, videos, at);
        if (!supported) { failure = 'unsupported'; throw new Error('Unsupported creator data'); }
        if (!matches.length) { failure = 'noMatch'; throw new Error('No linked work found'); }
        if (signal.aborted || closed) throw new Error('Creator sync interrupted');
        transaction(db, () => {
          if (!finish.run(1, 'ok', path, WORKBENCH_ACCOUNT, platform, at, day).changes) {
            throw new Error('Creator source disabled during sync');
          }
          for (const { video, sample } of matches) appendSnapshots(db, video, [sample], platform, { atomic: false });
          endRun.run(clock(), 1, null, JSON.stringify({ count: matches.length }), WORKBENCH_ACCOUNT, runId);
        });
      } catch {
        const health = signal.aborted || closed ? 'interrupted' : failure;
        transaction(db, () => {
          finish.run(0, health, null, WORKBENCH_ACCOUNT, platform, at, day);
          endRun.run(clock(), 0, health, null, WORKBENCH_ACCOUNT, runId);
        });
      } finally {
        await closeWindow(platform);
        changed();
      }
    });
  }

  async function disable(db, platform) {
    active.get(platform)?.controller.abort();
    ensure(db, platform);
    db.prepare("UPDATE creator_sources SET enabled = 0, health = 'off', path = NULL WHERE account_id = ? AND platform = ?")
      .run(WORKBENCH_ACCOUNT, platform);
    await closeWindow(platform);
    changed();
  }

  async function tick() {
    if (closed || ticking || windows.size || active.size || !creatorTime(clock()).due) return;
    ticking = true;
    try {
      const db = await openWorkbench();
      if (!db) return;
      for (const platform of Object.keys(PORTALS)) {
        if (closed) return;
        if (!active.has(platform)) await sync(db, platform);
      }
    } finally { ticking = false; }
  }

  return {
    start() {
      const check = () => { void tick().catch(() => {}); };
      timer = setInterval(check, 60_000).unref();
      check();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      const operations = [...active.values()];
      for (const { controller } of operations) controller.abort();
      await Promise.all([...windows.keys()].map(closeWindow));
      await Promise.allSettled(operations.map(({ operation }) => operation));
    },
    async route(req, res, parts, db) {
      if (req.method === 'GET' && !parts.length) return json(res, 200, { sources: status(db) });
      const [platform, action] = parts;
      if (req.method !== 'POST' || parts.length !== 2 || !Object.hasOwn(PORTALS, platform)) {
        throw new HttpError(404, 'Unknown creator source route');
      }
      if (action === 'open') await openSetup(db, platform);
      else if (action === 'connect') await sync(db, platform, true);
      else if (action === 'disable') await disable(db, platform);
      else throw new HttpError(404, 'Unknown creator source action');
      return json(res, 200, { sources: status(db) });
    },
  };
}
