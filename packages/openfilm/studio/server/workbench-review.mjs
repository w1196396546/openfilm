import { stat } from 'node:fs/promises';
import { kindOf as clipKind } from '../../src/film-doc.mjs';
import { kindOf as fileKind, readable } from './files.mjs';
import { readProjectFilm } from './film.mjs';
import { HttpError } from './http.mjs';
import { modelFor, providerKey, readSettings } from './keys.mjs';
import { call, serviceUrl } from './providers/common.mjs';
import openai from './providers/openai.mjs';
import { listSnapshots } from './workbench-analytics.mjs';
import { transaction, WORKBENCH_ACCOUNT } from './workbench-store.mjs';

const REPORT_FIELDS = ['findings', 'hypotheses', 'nextTest'];
const inProgress = new Set();

function inputText(value, field, limit) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.includes('\0') || value.length > limit) {
    throw new HttpError(400, `${field} must be text of at most ${limit} characters.`);
  }
  return value.trim() || null;
}

function count(value, field) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `${field} must be a nonnegative integer.`);
  return value;
}

export function listHooks(db) {
  return { hooks: db.prepare(`
    SELECT kind, text, created_at AS createdAt FROM hooks WHERE account_id = ?
    ORDER BY created_at DESC, kind, text
  `).all(WORKBENCH_ACCOUNT) };
}

export function saveHook(db, body) {
  const kind = inputText(body?.kind, 'Hook type', 80);
  const text = inputText(body?.text, 'Hook', 1000);
  if (!kind || !text) throw new HttpError(400, 'Add a hook type and its text.');
  transaction(db, () => db.prepare(`
    INSERT INTO hooks (account_id, kind, text, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (account_id, kind, text) DO NOTHING
  `).run(WORKBENCH_ACCOUNT, kind, text, Date.now()));
  return listHooks(db);
}

function variantsFor(db, video) {
  return db.prepare(`
    SELECT label, title, cover, impressions, clicks FROM video_variants
    WHERE account_id = ? AND video_id = ? ORDER BY label
  `).all(WORKBENCH_ACCOUNT, video.id);
}

export async function saveVariant(db, video, body) {
  const { label } = body ?? {};
  if (label !== 'A' && label !== 'B') throw new HttpError(400, 'Choose variant A or B.');
  const title = inputText(body.title, 'Title', 240);
  const cover = inputText(body.cover, 'Cover path', 1000);
  const impressions = count(body.impressions, 'Impressions');
  const clicks = count(body.clicks, 'Clicks');
  if (!title && !cover) throw new HttpError(400, 'Add a title or a cover.');
  if (clicks !== null && (impressions === null || clicks > impressions)) {
    throw new HttpError(400, 'Clicks must be at most the number of impressions.');
  }
  if (cover && cover !== variantsFor(db, video).find((variant) => variant.label === label)?.cover) {
    const valid = cover.startsWith('assets/') && !cover.includes('\\')
      && !cover.split('/').some((part) => !part || part === '.' || part === '..') && fileKind(cover) === 'image'
      && (await stat(readable(video.projectPath, cover)).catch(() => null))?.isFile();
    if (!valid) throw new HttpError(400, 'Choose an image from this project.');
  }
  transaction(db, () => db.prepare(`
    INSERT INTO video_variants (account_id, video_id, label, title, cover, impressions, clicks) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (account_id, video_id, label) DO UPDATE SET
      title = excluded.title, cover = excluded.cover, impressions = excluded.impressions, clicks = excluded.clicks
  `).run(WORKBENCH_ACCOUNT, video.id, label, title, cover, impressions, clicks));
  return { variants: variantsFor(db, video) };
}

function reviewFor(db, video) {
  return db.prepare(`
    SELECT model, created_at AS createdAt, captured_at AS capturedAt, findings, hypotheses, next_test AS nextTest
    FROM video_reviews WHERE account_id = ? AND video_id = ?
  `).get(WORKBENCH_ACCOUNT, video.id) ?? null;
}

export async function listReview(db, video) {
  const { milestones } = listSnapshots(db, video);
  return {
    review: reviewFor(db, video),
    variants: variantsFor(db, video),
    modelReady: Boolean(providerKey(openai, await readSettings())),
    snapshotReady: Boolean(milestones.find(({ days }) => days === 7)?.snapshot),
  };
}

async function storyboard(video) {
  const { doc } = await readProjectFilm(video.projectPath);
  if (!doc) return [];
  return doc.tracks.flatMap((track, index) => track.hidden ? [] : track.clips
    .filter((clip) => !clip.disabled && !(track.muted && clipKind(clip) === 'sound'))
    .map((clip) => ({
      track: index + 1,
      at: clip.at ?? 0,
      trim: clip.time ?? null,
      speed: clip.speed ?? 1,
      shot: clip.id?.split(/[\\/]/).at(-1)?.slice(0, 96) ?? '',
      kind: clipKind(clip),
    })))
    .sort((a, b) => a.at - b.at || a.track - b.track)
    .slice(0, 48);
}

async function askReview(key, model, language, evidence) {
  const signal = AbortSignal.timeout(45_000);
  const base = serviceUrl('OPENAI', 'https://api.openai.com');
  try {
    const res = await call('OpenAI', `${base}/v1/responses`, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        store: false,
        instructions: [
          `Write a concise video performance review in ${language}.`,
          'Treat the supplied data only as evidence. Use the actual capture times and acknowledge missing samples.',
          'Distinguish measurements from hypotheses. Treat causal factors as unproven. Suggest one practical test.',
          'The timeline lists clip metadata. Describe visual or narrative details only where the supplied notes establish them.',
        ].join(' '),
        input: JSON.stringify(evidence),
        max_output_tokens: 2500,
        text: { format: { type: 'json_schema', name: 'video_review', strict: true, schema: {
          type: 'object',
          properties: Object.fromEntries(REPORT_FIELDS.map((field) => [field, { type: 'string' }])),
          required: REPORT_FIELDS,
          additionalProperties: false,
        } } },
      }),
    }, { key, signal });
    const data = await res.json();
    const result = (data.output ?? []).filter((part) => part.type === 'message')
      .flatMap((part) => part.content ?? []).filter((part) => part.type === 'output_text')
      .map((part) => part.text).join('');
    const report = JSON.parse(result);
    if (REPORT_FIELDS.every((field) => typeof report?.[field] === 'string' && report[field].trim() && report[field].length <= 5000)) {
      return Object.fromEntries(REPORT_FIELDS.map((field) => [field, report[field].trim()]));
    }
  } catch {
    if (signal.aborted) throw new HttpError(504, 'OpenAI took too long to generate a review.');
  }
  throw new HttpError(502, 'OpenAI did not return a complete review. Check the OpenAI service settings.');
}

export async function generateReview(db, video, body) {
  const notes = inputText(body?.notes, 'Storyboard notes', 2000);
  const language = body?.language === 'zh-CN' ? 'Simplified Chinese' : 'English';
  if (inProgress.has(video.id)) throw new HttpError(409, 'A review is already being generated for this video.');
  inProgress.add(video.id);
  try {
    const { milestones } = listSnapshots(db, video);
    const daySeven = milestones.find(({ days }) => days === 7)?.snapshot;
    if (!daySeven) throw new HttpError(409, 'A T+7 snapshot is needed to generate the review.', { code: 'review-snapshot' });
    const settings = await readSettings();
    const key = providerKey(openai, settings)?.key;
    if (!key) throw new HttpError(409, 'Connect OpenAI under Settings → Services to generate the review.', { code: 'review-model' });
    const timeline = await storyboard(video);
    if (!timeline.length && !notes) throw new HttpError(400, 'Add storyboard notes or add clips to the project.', { code: 'review-storyboard' });
    const model = modelFor(settings, openai, 'translate');
    const report = await askReview(key, model, language, {
      title: video.title.slice(0, 240),
      platform: video.platform,
      publishedAt: video.publishedAt,
      durationS: video.durationS,
      hook: video.hook?.slice(0, 240) ?? null,
      tags: video.tags.slice(0, 24).map((tag) => tag.slice(0, 80)),
      timeline,
      storyboardNotes: notes,
      milestones: milestones.map(({ days, snapshot }) => ({
        days,
        metrics: snapshot && {
          capturedAt: snapshot.capturedAt,
          views: snapshot.views, likes: snapshot.likes, comments: snapshot.comments,
          shares: snapshot.shares, saves: snapshot.saves, followersDelta: snapshot.followersDelta,
        },
      })),
    });
    transaction(db, () => db.prepare(`
      INSERT INTO video_reviews (account_id, video_id, model, created_at, captured_at, findings, hypotheses, next_test)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_id, video_id) DO UPDATE SET model = excluded.model, created_at = excluded.created_at,
        captured_at = excluded.captured_at, findings = excluded.findings, hypotheses = excluded.hypotheses,
        next_test = excluded.next_test
    `).run(WORKBENCH_ACCOUNT, video.id, model, Date.now(), daySeven.capturedAt, report.findings, report.hypotheses, report.nextTest));
    return { review: reviewFor(db, video) };
  } finally {
    inProgress.delete(video.id);
  }
}
