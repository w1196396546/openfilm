// @ts-check
import { HttpError } from './http.mjs';
import { transaction, WORKBENCH_ACCOUNT } from './workbench-store.mjs';

/** @typedef {import('node:sqlite').DatabaseSync} Database */
/** @typedef {{ id: string, platform: string | null, publishedAt?: number | null }} Video */
/** @typedef {{ capturedAt: number, platform: string, views: number | null, likes: number | null, comments: number | null, shares: number | null, saves: number | null, followersDelta: number | null, source: string }} Snapshot */

const METRICS = /** @type {const} */ (['views', 'likes', 'comments', 'shares', 'saves', 'followersDelta']);
const COLUMNS = 'platform, captured_at AS capturedAt, views, likes, comments, shares, saves, followers_delta AS followersDelta, source';
const DAY = 86_400_000;
const MAX_ROWS = 10_000;

/** @param {Snapshot[]} snapshots @param {number | null} [publishedAt] @param {number} [now] */
export function milestoneSnapshots(snapshots, publishedAt, now = Date.now()) {
  return [1, 3, 7].map((days) => {
    if (publishedAt == null) return { days, snapshot: null };
    const target = publishedAt + days * DAY;
    const earliest = Math.max(publishedAt, target - DAY);
    const snapshot = target <= now ? snapshots.reduce((/** @type {Snapshot | null} */ best, row) => (
      row.capturedAt >= earliest && row.capturedAt <= target && (!best || row.capturedAt > best.capturedAt) ? row : best
    ), null) : null;
    return { days, snapshot };
  });
}

/** @param {Database} db @param {Video} video */
export function listSnapshots(db, video) {
  const snapshots = /** @type {Snapshot[]} */ (/** @type {unknown} */ (db.prepare(`SELECT ${COLUMNS} FROM snapshots
    WHERE account_id = ? AND video_id = ? ORDER BY captured_at, platform`).all(WORKBENCH_ACCOUNT, video.id)));
  return { snapshots, milestones: milestoneSnapshots(snapshots.filter((row) => row.platform === video.platform), video.publishedAt) };
}

/** @param {unknown} value */
function captureTime(value) {
  if (typeof value === 'string') {
    if (/^-?\d+$/.test(value)) return captureTime(Number(value));
    const date = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (date && !value.startsWith(`${date[1]}T24:`)) {
      const midnight = new Date(`${date[1]}T00:00:00Z`);
      const time = Date.parse(value);
      if (Number.isFinite(time) && Number.isFinite(+midnight) && midnight.toISOString().startsWith(date[1])) return captureTime(time);
    }
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= -62_167_219_200_000 && value <= 253_402_300_799_999) return value;
  throw new HttpError(400, 'capturedAt must be epoch milliseconds or an ISO date and time with a timezone.');
}

/** @param {unknown} input @param {Video} video @param {string} source */
function validate(input, video, source) {
  if (!video.platform) throw new HttpError(400, 'Set the video’s platform before adding snapshots.');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Expected a snapshot object.');
  const row = /** @type {Record<string, unknown>} */ (input);
  if (row.platform != null && row.platform !== '' && row.platform !== video.platform) throw new HttpError(400, 'The snapshot platform must match the video’s platform.');
  const capturedAt = captureTime(row.capturedAt);
  const metrics = METRICS.map((name) => {
    const raw = row[name];
    if (raw == null || raw === '') return null;
    const value = typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || (name !== 'followersDelta' && value < 0)) {
      throw new HttpError(400, `${name} must be ${name === 'followersDelta' ? 'an integer' : 'a nonnegative integer'}.`);
    }
    return value;
  });
  if (metrics.every((value) => value == null)) throw new HttpError(400, 'Enter at least one metric for each snapshot.');
  return { capturedAt, platform: video.platform, metrics, source };
}

/** @param {unknown} input */
function csvRows(input) {
  if (typeof input !== 'string' || !input.trim()) throw new HttpError(400, 'Choose a CSV file with a header and at least one data row.');
  if (input.length > 1_048_576) throw new HttpError(413, 'The CSV is larger than 1 MiB.');
  const content = input.replace(/^\uFEFF/, '');
  const field = /(?:"((?:[^"]|"")*)"|([^",\r\n]*))(\r\n|[,\r\n]|$)/y;
  /** @type {string[][]} */ const rows = [];
  /** @type {string[]} */ let row = [];
  for (let offset = 0; offset < content.length;) {
    field.lastIndex = offset;
    const match = field.exec(content);
    if (!match) throw new HttpError(400, `Malformed CSV at row ${rows.length + 1}.`);
    row.push((match[1]?.replaceAll('""', '"') ?? match[2]).trim());
    offset = field.lastIndex;
    if (match[3] === ',') {
      if (offset !== content.length) continue;
      row.push('');
    }
    if (row.length > 1 || row[0]) rows.push(row);
    if (rows.length > MAX_ROWS + 1) throw new HttpError(413, `Import up to ${MAX_ROWS} snapshots at a time.`);
    row = [];
  }
  const [header, ...data] = rows;
  const aliases = new Map([['captured_at', 'capturedAt'], ['followers_delta', 'followersDelta']]);
  const columns = header?.map((name) => aliases.get(name) ?? name);
  if (!columns?.includes('capturedAt') || !data.length || new Set(columns).size !== columns.length
    || columns.some((name) => !['capturedAt', 'platform', ...METRICS].includes(name))) {
    throw new HttpError(400, 'CSV needs a capturedAt column, supported metric headers and at least one data row.');
  }
  return data.map((values, index) => {
    if (values.length !== columns.length) throw new HttpError(400, `Wrong number of CSV fields in data row ${index + 1}.`);
    return Object.fromEntries(columns.map((name, column) => [name, values[column]]));
  });
}

/** @param {Database} db @param {Video} video @param {unknown[]} rows @param {string} source @param {{ atomic?: boolean }} [options] */
export function appendSnapshots(db, video, rows, source, { atomic = true } = {}) {
  if (!rows.length || rows.length > MAX_ROWS) throw new HttpError(400, `Provide 1 to ${MAX_ROWS} snapshots.`);
  const validated = rows.map((row, index) => {
    try { return validate(row, video, source); }
    catch (error) {
      if (source === 'csv' && error instanceof HttpError) throw new HttpError(error.status, `CSV data row ${index + 1}: ${error.message}`);
      throw error;
    }
  });
  const insert = db.prepare(`INSERT INTO snapshots (account_id, video_id, platform, captured_at, views, likes, comments, shares, saves, followers_delta, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (account_id, video_id, platform, captured_at) DO NOTHING`);
  const lookup = db.prepare(`SELECT ${COLUMNS} FROM snapshots WHERE account_id = ? AND video_id = ? AND platform = ? AND captured_at = ?`);
  const write = () => {
    let added = 0;
    for (const row of validated) {
      const key = /** @type {const} */ ([WORKBENCH_ACCOUNT, video.id, row.platform, row.capturedAt]);
      if (insert.run(...key, ...row.metrics, row.source).changes) added++;
      else {
        const existing = lookup.get(...key);
        if (!METRICS.every((metric, index) => existing?.[metric] === row.metrics[index])) {
          throw new HttpError(409, `A snapshot with different metrics already exists at ${new Date(row.capturedAt).toISOString()}.`);
        }
      }
    }
    return added;
  };
  const added = atomic ? transaction(db, write) : write();
  return { ...listSnapshots(db, video), added };
}

/** @param {Database} db @param {Video} video @param {unknown} body */
export function addSnapshots(db, video, body) {
  if (body && typeof body === 'object' && 'csv' in body) {
    if ('platform' in body && body.platform !== video.platform) throw new HttpError(409, 'The video’s platform has changed. Reopen its details and try again.');
    return appendSnapshots(db, video, csvRows(body.csv), 'csv');
  }
  return appendSnapshots(db, video, [body], 'manual');
}

/** @param {string} value */
const md = (value) => value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]<>|]/g, '\\$&');
/** @param {number} time */
const localDay = (time) => new Date(time).toLocaleDateString('zh-CN');

/** @param {Database} db @param {number} [now] */
export function weeklyReport(db, now = Date.now()) {
  const start = now - 7 * DAY;
  /** @typedef {Snapshot & { id: string, title: string, publishedAt: number | null, durationS: number | null, hook: string | null, tags: string, currentPlatform: string | null }} ReportRow */
  const rows = /** @type {ReportRow[]} */ (/** @type {unknown} */ (db.prepare(`SELECT v.id, v.title, v.published_at AS publishedAt,
    v.duration_s AS durationS, v.hook, v.tags, v.platform AS currentPlatform, s.platform, s.captured_at AS capturedAt,
    s.views, s.likes, s.comments, s.shares, s.saves, s.followers_delta AS followersDelta, s.source
    FROM snapshots s JOIN videos v ON v.account_id = s.account_id AND v.id = s.video_id
    WHERE s.account_id = ? AND s.captured_at BETWEEN ? AND ? ORDER BY s.captured_at`).all(WORKBENCH_ACCOUNT, start - DAY, now)));
  /** @type {Map<string, ReportRow[]>} */ const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify([row.id, row.platform]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const lines = [`# 视频数据周报`, '', `${localDay(start)} 至 ${localDay(now)}`, '', '## 本周记录', '',
    '| 作品 | 平台 | 最新采样 | 播放 | 点赞 | 评论 | 分享 | 收藏 | 涨粉 | 播放变化 |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
  const headerLength = lines.length;
  /** @type {Map<string, { sum: number, count: number }>} */ const combinations = new Map();
  for (const group of groups.values()) {
    const latest = group.at(-1);
    if (!latest) continue;
    if (latest.capturedAt >= start) {
      const baseline = group.findLast((row) => row.capturedAt <= start) ?? group[0];
      const delta = baseline !== latest && baseline.views != null && latest.views != null ? latest.views - baseline.views : null;
      lines.push(`| ${md(latest.title)} | ${md(latest.platform)} | ${localDay(latest.capturedAt)} | ${METRICS.map((metric) => latest[metric] ?? '—').join(' | ')} | ${delta ?? '—'} |`);
    }
    const published = latest.publishedAt;
    if (published == null || published + 7 * DAY < start || latest.currentPlatform !== latest.platform) continue;
    const week = milestoneSnapshots(group, published, now).find(({ days }) => days === 7)?.snapshot;
    if (week?.views == null) continue;
    const duration = latest.durationS == null ? '未记录' : latest.durationS < 30 ? '<30 秒' : latest.durationS < 60 ? '30–59 秒' : '≥60 秒';
    const hour = new Date(published).getHours();
    const slot = `${Math.floor(hour / 6) * 6}:00–${Math.floor(hour / 6) * 6 + 6}:00`;
    const tags = /** @type {string[]} */ (JSON.parse(latest.tags));
    const key = [latest.hook || '未记录', duration, slot, [...new Set(tags)].sort().join('、') || '未标记'].join(' × ');
    const result = combinations.get(key) ?? { sum: 0, count: 0 };
    result.sum += week.views;
    result.count++;
    combinations.set(key, result);
  }
  if (lines.length === headerLength) lines.push('| 本周暂无快照 | | | | | | | | | |');
  lines.push('', '播放变化取周起点附近的快照到本周最新快照的差值。只有一个采样点时显示「—」。', '',
    '## 本周达到 T+7 的作品组合', '', '按钩子 × 时长 × 发布时间段 × 选题标签汇总。', '',
    '| 组合 | 样本 | 平均播放 |', '| --- | ---: | ---: |');
  for (const [key, value] of [...combinations].sort((a, b) => b[1].sum / b[1].count - a[1].sum / a[1].count)) {
    lines.push(`| ${md(key)} | ${value.count} | ${Math.round(value.sum / value.count)} |`);
  }
  if (!combinations.size) lines.push('| 暂无可比较的 T+7 快照 | | |');
  return { markdown: `${lines.join('\n')}\n` };
}
