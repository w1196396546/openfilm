// @ts-check
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writeAtomic } from './atomic.mjs';
import { readProjectFilm } from './film.mjs';
import { HttpError } from './http.mjs';
import { TOOL_DIR, listProjects, studioHome } from './projects.mjs';
import { WORKBENCH_REVIEW_SCHEMA } from './workbench-review-schema.mjs';

export const WORKBENCH_ACCOUNT = 'me';
export const PRODUCTION_STATUSES = /** @type {const} */ ([
  'idea', 'script', 'storyboard', 'production', 'review', 'ready', 'scheduled', 'published', 'analyzing',
]);
const DAY = 86_400_000;

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {Awaited<ReturnType<typeof listProjects>>[number]} Project */
/** @typedef {{ status: typeof PRODUCTION_STATUSES[number], tags: string[], platform: string|null, videoUrl: string|null,
 * scheduledAt: number|null, publishedAt: number|null, hook: string|null, topicId: string|null }} Production */
/** @typedef {{ capturedAt: number, platform: string, source: string, views: number|null, likes: number|null,
 * comments: number|null, shares: number|null, saves: number|null, followersDelta: number|null }} Snapshot */

const migrations = [`
  CREATE TABLE videos (
    account_id TEXT NOT NULL, id TEXT NOT NULL, project_path TEXT NOT NULL, project_id TEXT NOT NULL,
    title TEXT NOT NULL, status TEXT NOT NULL, platform TEXT, video_url TEXT, scheduled_at INTEGER, published_at INTEGER,
    duration_s REAL, tags TEXT NOT NULL, hook TEXT, topic_id TEXT, created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, id)
  );
  CREATE TABLE snapshots (
    id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, video_id TEXT NOT NULL, platform TEXT NOT NULL,
    captured_at INTEGER NOT NULL, views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, saves INTEGER,
    followers_delta INTEGER, source TEXT NOT NULL,
    UNIQUE (account_id, video_id, platform, captured_at),
    FOREIGN KEY (account_id, video_id) REFERENCES videos (account_id, id)
  );
  CREATE INDEX snapshots_video_time ON snapshots (account_id, video_id, captured_at DESC);
  CREATE TABLE topics (
    account_id TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, heat REAL, rank INTEGER,
    first_seen INTEGER NOT NULL, score REAL, status TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL,
    url TEXT, format TEXT, updated_at INTEGER, project_id TEXT,
    PRIMARY KEY (account_id, id)
  );
  CREATE TABLE "references" (
    account_id TEXT NOT NULL, id TEXT NOT NULL, platform TEXT, url TEXT NOT NULL, author TEXT, title TEXT,
    metrics_json TEXT, breakdown_json TEXT, topic_id TEXT, added_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, id)
  );
  CREATE TABLE runs (
    account_id TEXT NOT NULL, id TEXT NOT NULL, job TEXT NOT NULL, started_at INTEGER NOT NULL,
    finished_at INTEGER, ok INTEGER, error TEXT, result_json TEXT,
    PRIMARY KEY (account_id, id)
  );
  CREATE INDEX runs_job_time ON runs (account_id, job, started_at DESC);
  CREATE TABLE creator_sources (
    account_id TEXT NOT NULL, platform TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, path TEXT,
    last_attempt_day TEXT, health TEXT NOT NULL DEFAULT 'off', last_run_at INTEGER,
    PRIMARY KEY (account_id, platform)
  );
`, WORKBENCH_REVIEW_SCHEMA];

/** @template T @param {Database} db @param {() => T} write */
export function transaction(db, write) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = write();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** @type {Map<string, Promise<Database|null>>} */
const connections = new Map();

/** SQLite is optional for the rest of Studio on runtimes that lack the built-in module. */
export function openWorkbench() {
  const home = studioHome();
  const opened = connections.get(home);
  if (opened) return opened;
  const opening = (async () => {
    let sqlite;
    try { sqlite = await import('node:sqlite'); } catch { return null; }
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const file = join(home, 'workbench.db');
    closeSync(openSync(file, 'a', 0o600));
    const db = new sqlite.DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      for (let attempt = 0; ; attempt++) {
        try { db.exec('PRAGMA journal_mode = WAL'); break; }
        catch (error) {
          // SQLite can skip its busy timeout while another process is also changing journal modes.
          if (/** @type {{errcode?: number}} */ (error).errcode !== 5 || attempt === 5) throw error;
          await delay(25 * 2 ** attempt);
        }
      }
      transaction(db, () => {
        db.exec('CREATE TABLE IF NOT EXISTS meta (account_id TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL)');
        const version = Number(db.prepare('SELECT version FROM meta WHERE account_id = ?').get(WORKBENCH_ACCOUNT)?.version ?? 0);
        if (version > migrations.length) throw new Error('The workbench database was created by a newer OpenFilm.');
        if (version === migrations.length) return;
        for (const migration of migrations.slice(version)) db.exec(migration);
        db.prepare('INSERT OR REPLACE INTO meta (account_id, version) VALUES (?, ?)').run(WORKBENCH_ACCOUNT, migrations.length);
      });
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  })().catch((error) => {
    connections.delete(home);
    throw error;
  });
  connections.set(home, opening);
  return opening;
}

/** Release the process's connection so SQLite checkpoints its WAL on a normal shutdown. */
export async function closeWorkbench() {
  const home = studioHome();
  const opening = connections.get(home);
  const db = await opening?.catch(() => null);
  connections.delete(home);
  db?.close();
}

/** @type {Production} */
const defaults = { status: 'idea', tags: [], platform: null, videoUrl: null, scheduledAt: null, publishedAt: null, hook: null, topicId: null };

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value @param {number} max @returns {value is string} */
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max && !/[\x00-\x1f\x7f]/.test(value);

/** @param {unknown} value @returns {value is string} */
function httpUrl(value) {
  if (!text(value, 2048)) return false;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

/** @param {Record<string, unknown>} raw @param {boolean} [strict] @returns {Partial<Production>} */
function productionFields(raw, strict = false) {
  /** @type {Partial<Production>} */
  const value = {};
  /** @param {string} key */
  const invalid = (key) => { if (strict) throw new HttpError(400, `Invalid production field: ${key}`); };
  if (Object.hasOwn(raw, 'status')) {
    const status = PRODUCTION_STATUSES.find((s) => s === raw.status);
    if (status) value.status = status;
    else invalid('status');
  }
  if (Object.hasOwn(raw, 'tags')) {
    if (Array.isArray(raw.tags) && raw.tags.length <= 40 && raw.tags.every((tag) => text(tag, 80))) {
      value.tags = [...new Set(raw.tags.map((tag) => tag.trim()))];
    } else invalid('tags');
  }
  for (const key of /** @type {const} */ (['scheduledAt', 'publishedAt'])) {
    if (!Object.hasOwn(raw, key)) continue;
    const date = raw[key];
    if (date === null || (typeof date === 'number' && Number.isSafeInteger(date) && date >= 0 && date <= 8.64e15)) value[key] = date;
    else invalid(key);
  }
  for (const key of /** @type {const} */ (['platform', 'videoUrl', 'hook', 'topicId'])) {
    if (!Object.hasOwn(raw, key)) continue;
    const item = raw[key];
    if (item === null) value[key] = null;
    else if (typeof item === 'string' && (key === 'videoUrl' ? httpUrl(item) : text(item, key === 'platform' ? 40 : 160))) value[key] = item.trim();
    else invalid(key);
  }
  if (strict) for (const key of Object.keys(raw)) if (!Object.hasOwn(defaults, key)) invalid(key);
  return value;
}

/** @param {string} path @returns {Promise<Record<string, unknown>>} */
async function readProduction(path) {
  if (!(await lstat(dirname(path))).isDirectory()) throw new HttpError(409, 'The project metadata folder must be inside the project.');
  try {
    if (!(await lstat(path)).isFile()) throw new HttpError(409, 'The production record must be a regular file.');
    const record = JSON.parse(await readFile(path, 'utf8'));
    if (isRecord(record)) return record;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return {};
    if (!(error instanceof SyntaxError)) throw error;
  }
  throw new HttpError(409, 'The production record has invalid JSON.');
}

const productionPath = (/** @type {Project} */ project) => join(project.path, TOOL_DIR, 'production.json');

/** @param {Project} project @param {Production} production */
async function videoOf(project, production) {
  // A film can have clips before Studio has drawn a poster and cached its duration.
  const hasPoster = !project.missing && (project.cover != null || (project.duration ?? 0) > 0 || await readProjectFilm(project.path)
    .then(({ doc }) => Boolean(doc?.tracks.some((track) => track.clips.length)), () => false));
  return {
    id: project.id, projectId: project.id, projectPath: project.path, title: project.name, accountId: WORKBENCH_ACCOUNT,
    ...production, createdAt: project.createdAt, durationS: project.duration ?? null, cover: project.cover, missing: project.missing, hasPoster,
  };
}

/** @param {Database} db @param {string} id */
function indexedProduction(db, id) {
  const row = db.prepare(`SELECT status, tags, platform, video_url AS videoUrl, scheduled_at AS scheduledAt,
    published_at AS publishedAt, hook, topic_id AS topicId FROM videos WHERE account_id = ? AND id = ?`).get(WORKBENCH_ACCOUNT, id);
  return row ? { ...defaults, ...productionFields({ ...row, tags: JSON.parse(String(row.tags)) }) } : defaults;
}

/** @param {Database} db @param {Awaited<ReturnType<typeof videoOf>>[]} videos */
function writeIndex(db, videos) {
  if (!videos.length) return;
  const upsert = db.prepare(`INSERT INTO videos (account_id, id, project_path, project_id, title, status, platform, video_url,
    scheduled_at, published_at, duration_s, tags, hook, topic_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_id, id) DO UPDATE SET project_path = excluded.project_path, title = excluded.title,
      status = excluded.status, platform = excluded.platform, video_url = excluded.video_url,
      scheduled_at = excluded.scheduled_at, published_at = excluded.published_at, duration_s = excluded.duration_s,
      tags = excluded.tags, hook = excluded.hook, topic_id = excluded.topic_id`);
  transaction(db, () => {
    for (const v of videos) upsert.run(v.accountId, v.id, v.projectPath, v.projectId, v.title, v.status, v.platform,
      v.videoUrl, v.scheduledAt, v.publishedAt, v.durationS, JSON.stringify(v.tags), v.hook, v.topicId, v.createdAt);
  });
}

/** @param {Database} db @param {Awaited<ReturnType<typeof videoOf>>[]} videos */
function withMetrics(db, videos) {
  const now = Date.now();
  const cutoff = now - 7 * DAY;
  const latest = db.prepare(`SELECT captured_at AS capturedAt, views, likes, comments, shares, saves,
    followers_delta AS followersDelta, platform, source FROM snapshots WHERE account_id = ? AND video_id = ?
    AND (? IS NULL OR platform = ?) AND captured_at BETWEEN ? AND ? ORDER BY captured_at DESC, id DESC LIMIT 1`);
  const baseline = db.prepare(`SELECT views FROM snapshots WHERE account_id = ? AND video_id = ? AND platform = ?
    AND captured_at BETWEEN ? AND ? AND views IS NOT NULL ORDER BY captured_at DESC LIMIT 1`);
  return videos.map((video) => {
    const { accountId, id, platform, publishedAt } = video;
    const latestSnapshot = /** @type {Snapshot|undefined} */ (latest.get(accountId, id, platform, platform, publishedAt ?? 0, now)) ?? null;
    let recentViews = null;
    if (typeof latestSnapshot?.views === 'number' && latestSnapshot.capturedAt >= cutoff) {
      const before = baseline.get(accountId, id, latestSnapshot.platform, publishedAt ?? 0, cutoff)?.views;
      if (typeof before === 'number') recentViews = latestSnapshot.views - before;
      else if (publishedAt !== null && publishedAt >= cutoff) recentViews = latestSnapshot.views;
    }
    return { ...video, latestSnapshot, recentViews };
  });
}

let indexTurn = Promise.resolve();
/** @template T @param {() => Promise<T>} change */
function exclusive(change) {
  const run = indexTurn.then(change, change);
  indexTurn = run.then(() => {}, () => {});
  return run;
}

/** @param {Database} db */
export function listVideos(db) {
  return exclusive(async () => {
    const projects = await listProjects();
    const videos = await Promise.all(projects.map(async (project) => {
      const record = project.missing ? null : await readProduction(productionPath(project)).catch(() => null);
      return videoOf(project, record ? { ...defaults, ...productionFields(record) } : indexedProduction(db, project.id));
    }));
    writeIndex(db, videos.filter((v) => !v.missing));
    return withMetrics(db, videos);
  });
}

/** @param {Database} db @param {string} id @param {unknown} patch */
export async function patchVideo(db, id, patch) {
  if (!isRecord(patch)) throw new HttpError(400, 'Production changes must be an object.');
  const updates = productionFields(patch, true);
  return exclusive(async () => {
    const project = (await listProjects()).find((p) => p.id === id);
    if (!project) throw new HttpError(404, 'No such project.');
    if (project.missing) throw new HttpError(410, 'The project is missing.');
    const path = productionPath(project);
    const record = await readProduction(path);
    await writeAtomic(path, `${JSON.stringify({ ...record, ...updates }, null, 2)}\n`);
    const video = await videoOf(project, { ...defaults, ...productionFields(record), ...updates });
    writeIndex(db, [video]);
    return withMetrics(db, [video])[0];
  });
}
