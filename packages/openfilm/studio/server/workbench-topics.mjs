// @ts-check
import { randomUUID } from 'node:crypto';
import { HttpError } from './http.mjs';
import { createProject, projectById } from './projects.mjs';
import { patchVideo, transaction, WORKBENCH_ACCOUNT as owner } from './workbench-store.mjs';

/** @typedef {import('node:sqlite').DatabaseSync} Store */
/** @typedef {Record<string, import('node:sqlite').SQLOutputValue>} Row */

/** @param {Row} row */
function topicRow(row) {
  return {
    id: String(row.id), title: String(row.title), source: row.source, status: row.status,
    heat: row.heat, rank: row.rank, score: row.score, url: row.url, reason: row.reason,
    format: row.format, firstSeen: row.first_seen, projectId: row.project_id,
  };
}

/** @param {Store} db @param {string} id */
export function getTopic(db, id) {
  const row = db.prepare('SELECT * FROM topics WHERE account_id = ? AND id = ?').get(owner, id);
  if (!row) throw new HttpError(404, 'Topic not found.');
  return topicRow(row);
}

/** @param {Store} db */
export function listTopics(db) {
  const saved = db.prepare("SELECT * FROM topics WHERE account_id = ? AND (status != 'new' OR source = 'manual') ORDER BY updated_at DESC").all(owner);
  const recent = db.prepare("SELECT * FROM topics WHERE account_id = ? AND status = 'new' AND source != 'manual' ORDER BY updated_at DESC, id LIMIT 200").all(owner);
  return { topics: [...saved, ...recent].map(topicRow) };
}

/** @param {unknown} value @param {string} name @param {number} limit @param {boolean} [optional] */
function stringField(value, name, limit, optional = false) {
  if (optional && (value == null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) {
    throw new HttpError(400, `Enter a valid ${name} of at most ${limit} characters.`);
  }
  return value.trim();
}

/** @param {Store} db @param {{title?: unknown}} body */
export function addTopic(db, body) {
  const title = stringField(body?.title, 'topic title', 240);
  const id = randomUUID();
  const at = Date.now();
  transaction(db, () => db.prepare(`INSERT INTO topics
    (account_id, id, title, source, status, first_seen, created_at, updated_at)
    VALUES (?, ?, ?, 'manual', 'saved', ?, ?, ?)`).run(owner, id, title, at, at, at));
  return { topic: getTopic(db, id) };
}

/** @param {Store} db @param {string} id @param {{status?: unknown}} body */
export function updateTopic(db, id, body) {
  const { status } = body ?? {};
  if (status !== 'new' && status !== 'saved') throw new HttpError(400, 'Select a valid topic status.');
  transaction(db, () => {
    if (getTopic(db, id).projectId) throw new HttpError(409, 'A project has already started from this topic.');
    db.prepare('UPDATE topics SET status = ?, updated_at = ? WHERE account_id = ? AND id = ?').run(status, Date.now(), owner, id);
  });
  return { topic: getTopic(db, id) };
}

/** @type {WeakMap<Store, Map<string, Promise<{ video: Awaited<ReturnType<typeof patchVideo>> }>>>} */
const starts = new WeakMap();

/** @param {Store} db @param {string} id */
export function startTopic(db, id) {
  const inProgress = starts.get(db) ?? new Map();
  starts.set(db, inProgress);
  const existing = inProgress.get(id);
  if (existing) return existing;
  const start = (async () => {
    const topic = getTopic(db, id);
    let projectId = typeof topic.projectId === 'string' ? topic.projectId : null;
    if (projectId) {
      const project = await projectById(projectId).catch(() => null);
      if (!project || project.missing) throw new HttpError(409, 'The project started from this topic is missing. Locate it in Studio.');
    } else {
      const project = await createProject(topic.title.replace(/^[.\s/\\:*?"<>|]+/, '').slice(0, 110).trim() || 'New video');
      projectId = project.id;
      transaction(db, () => db.prepare('UPDATE topics SET project_id = ?, status = ?, updated_at = ? WHERE account_id = ? AND id = ?')
        .run(project.id, 'started', Date.now(), owner, id));
    }
    const video = await patchVideo(db, projectId, { topicId: id });
    return { video };
  })().finally(() => inProgress.delete(id));
  inProgress.set(id, start);
  return start;
}

/** @param {Row} row */
function referenceRow(row) {
  return {
    id: row.id, topicId: row.topic_id, platform: row.platform, url: row.url, title: row.title,
    author: row.author, breakdown: row.breakdown_json ? JSON.parse(String(row.breakdown_json)) : null,
    addedAt: row.added_at,
  };
}

/** @param {Store} db */
export function listReferences(db) {
  return { references: db.prepare('SELECT * FROM "references" WHERE account_id = ? ORDER BY added_at DESC, id').all(owner).map(referenceRow) };
}

/** @param {Store} db @param {{topicId?:unknown,platform?:unknown,url?:unknown,title?:unknown,author?:unknown,breakdown?:unknown}} body */
export function addReference(db, body) {
  const title = stringField(body?.title, 'reference title', 240);
  const platform = stringField(body?.platform, 'platform', 40);
  const topicId = stringField(body?.topicId, 'topic ID', 128, true);
  const author = stringField(body?.author, 'author', 160, true);
  const breakdown = stringField(body?.breakdown, 'breakdown', 20_000, true);
  let url;
  try { url = new URL(stringField(body?.url, 'reference URL', 2048) ?? ''); }
  catch { throw new HttpError(400, 'Enter a valid HTTP or HTTPS reference URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new HttpError(400, 'Enter a valid HTTP or HTTPS reference URL.');
  const id = randomUUID();
  const row = transaction(db, () => {
    if (topicId) getTopic(db, topicId);
    return db.prepare(`INSERT INTO "references" (account_id, id, title, platform, url, author, breakdown_json, topic_id, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(owner, id, title, platform, url.href, author, JSON.stringify(breakdown), topicId, Date.now());
  });
  if (!row) throw new Error('Reference was not saved.');
  return { reference: referenceRow(row) };
}
