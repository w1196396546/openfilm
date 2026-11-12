// @ts-check
/** Daily public trends and one-way delivery. An atomic daily claim survives a Studio restart. */
import { join } from 'node:path';
import { HttpError } from './http.mjs';
import { changeSettings, readSettings } from './keys.mjs';
import { studioHome } from './projects.mjs';
import { backupHotSources, hotSources, limitedJson } from './social/hot-sources.mjs';
import { hotTopicId, scoreHotTopics } from './workbench-score.mjs';
import { WORKBENCH_ACCOUNT, listVideos, openWorkbench, transaction } from './workbench-store.mjs';

/** @typedef {import('node:sqlite').DatabaseSync} Db */
/** @typedef {import('./social/hot-sources.mjs').HotChart} HotChart */
/** @typedef {import('./workbench-score.mjs').Candidate} Candidate */
/** @typedef {import('./workbench-score.mjs').Recommendation} Recommendation */
/** @typedef {typeof hotSources[number]} Source */
/** @typedef {'direct' | 'newsnow' | 'dailyhot'} ChartProvider */
/** @typedef {HotChart & { fetchedAt: string, via?: ChartProvider }} ChartCache */
/** @typedef {HotChart & { id: Source['id'], name: string, fetchedAt: string | null, via?: ChartProvider, status: 'fresh' | 'stale' | 'unavailable' | 'disabled' }} SourceView */
/** @typedef {{ date: string, generatedAt: string, topics: Recommendation[], ranking: 'semantic' | 'keywords' | 'heat' }} Digest */
/** @typedef {{ finished_at: number | null, started_at: number, ok: number | null, error: string | null, result_json: string | null }} Run */
/** @typedef {Awaited<ReturnType<typeof readSettings>>} Settings */

const MINUTE = 60_000;
const CACHE_TIME = 45 * MINUTE;
const STALE_TIME = 90 * MINUTE;
const TIMEOUT = 9000;
const ZONE = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });
const CHANNELS = /** @type {const} */ (['feishu', 'wecom']);
const ENV = { feishu: 'OPENFILM_FEISHU_WEBHOOK', wecom: 'OPENFILM_WECOM_WEBHOOK' };
const ACCOUNT = WORKBENCH_ACCOUNT;

/** @param {Db} db @param {string} id */
const readRun = (db, id) => /** @type {Run | undefined} */ (db.prepare('SELECT * FROM runs WHERE account_id = ? AND id = ?').get(ACCOUNT, id));
/** @param {Run | undefined} run */
const resultOf = (run) => run?.result_json ? JSON.parse(run.result_json) : null;
const localTime = (/** @type {number} */ time) => ZONE.format(time).split(' ');

/** Only the providers' group-robot routes can receive a secret or the digest. @param {typeof CHANNELS[number]} id @param {unknown} input */
function webhookUrl(id, input) {
  if (typeof input !== 'string' || input.length > 512) return null;
  try {
    const url = new URL(input.trim());
    if (url.username || url.password || url.hash) return null;
    if (id === 'feishu' && url.origin === 'https://open.feishu.cn' && !url.search
      && /^\/open-apis\/bot\/v2\/hook\/[a-zA-Z0-9_-]{8,128}$/.test(url.pathname)) return url;
    if (id === 'wecom' && url.origin === 'https://qyapi.weixin.qq.com' && url.pathname === '/cgi-bin/webhook/send'
      && [...url.searchParams].length === 1 && /^[a-zA-Z0-9_-]{8,128}$/.test(url.searchParams.get('key') ?? '')) return url;
  } catch { /* No URL or credentials from the request go into errors. */ }
  return null;
}

/** @param {Settings} settings @param {typeof CHANNELS[number]} id */
function destination(settings, id) {
  const env = process.env[ENV[id]]?.trim();
  return { fromEnv: Boolean(env), url: webhookUrl(id, env || settings.keys[id]) };
}

/** @param {Settings} settings */
function publicSettings(settings) {
  const sources = Object.fromEntries(hotSources.map(({ id }) => [id, !settings.off.includes(id)]));
  const webhooks = Object.fromEntries(CHANNELS.map((id) => {
    const { fromEnv, url } = destination(settings, id);
    return [id, { fromEnv, configured: Boolean(url), last4: url ? (url.searchParams.get('key') ?? url.pathname).slice(-4) : null }];
  }));
  return { sources, webhooks };
}

/** @param {unknown} value @param {string} field @returns {Record<string, unknown>} */
function settingsRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `Invalid workbench ${field}`);
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {string} file @param {unknown} input */
async function updateTrendSettings(file, input) {
  const patch = settingsRecord(input, 'settings');
  const sources = settingsRecord(patch.sources ?? {}, 'sources');
  const webhooks = settingsRecord(patch.webhooks ?? {}, 'webhooks');
  const sourceEdits = hotSources.filter(({ id }) => Object.hasOwn(sources, id)).map(({ id }) => {
    if (typeof sources[id] !== 'boolean') throw new HttpError(400, 'A source setting must be on or off');
    return { id, enabled: sources[id] };
  });
  const webhookEdits = CHANNELS.filter((id) => Object.hasOwn(webhooks, id)).map((id) => {
    const url = webhookUrl(id, webhooks[id]);
    if (webhooks[id] !== null && !url) throw new HttpError(400, `Use a valid ${id === 'feishu' ? 'Feishu' : 'WeCom'} group robot webhook URL`);
    return { id, url };
  });
  return publicSettings(await changeSettings((settings) => {
    for (const { id, enabled } of sourceEdits) {
      settings.off = settings.off.filter((name) => name !== id);
      if (!enabled) settings.off.push(id);
    }
    for (const { id, url } of webhookEdits) {
      if (url) settings.keys[id] = url.href;
      else delete settings.keys[id];
    }
  }, file));
}

/** @param {Db} db @param {Source} source @param {Settings} settings @param {number} now @returns {SourceView} */
function sourceView(db, { id, name }, settings, now) {
  if (settings.off.includes(id)) return { id, name, status: 'disabled', updatedAt: null, fetchedAt: null, items: [] };
  const run = readRun(db, `hot-cache:${id}`);
  const data = /** @type {ChartCache | null} */ (resultOf(run));
  if (!data) return { id, name, status: 'unavailable', updatedAt: null, fetchedAt: null, items: [] };
  const status = run?.ok === 0 ? 'unavailable' : chartFresh(data, now) ? 'fresh' : 'stale';
  return { id, name, status, via: 'direct', ...data };
}

/** @param {ChartCache} data @param {number} now */
function chartFresh(data, now) {
  const age = now - Date.parse(data.updatedAt ?? data.fetchedAt);
  return age >= -5 * MINUTE && age <= STALE_TIME;
}

/** @param {Db} db @param {string} id @param {string} job @param {number} time @param {number} [ttl] */
function claimRun(db, id, job, time, ttl) {
  return transaction(db, () => {
    const prior = readRun(db, id);
    if (prior && (ttl === undefined || time - prior.started_at < ttl)) return false;
    db.prepare(`INSERT INTO runs (account_id, id, job, started_at, finished_at, ok, error, result_json)
      VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL)
      ON CONFLICT(account_id, id) DO UPDATE SET started_at = excluded.started_at, finished_at = NULL, ok = NULL, error = NULL`)
      .run(ACCOUNT, id, job, time);
    return true;
  });
}

/** @param {Db} db @param {string} id @param {number} time @param {boolean} ok @param {string | null} error @param {unknown} [result] */
function finishRun(db, id, time, ok, error, result) {
  transaction(db, () => db.prepare(`UPDATE runs SET finished_at = ?, ok = ?, error = ?, result_json = COALESCE(?, result_json)
    WHERE account_id = ? AND id = ?`).run(time, Number(ok), error, result === undefined ? null : JSON.stringify(result), ACCOUNT, id));
}

/** @param {Db} db @param {SourceView[]} sources @param {number} time @returns {Candidate[]} */
function keepCandidates(db, sources, time) {
  /** @type {Map<string, Omit<Candidate, 'firstSeen' | 'referenceCount'>>} */
  const candidates = new Map();
  for (const source of sources.filter((entry) => entry.status === 'fresh')) {
    const maxHeat = Math.max(1, ...source.items.map(({ heat }) => heat ?? 0));
    for (const item of source.items) {
      const id = hotTopicId(item.title);
      if (candidates.has(id)) continue; // Douyin is first and gets priority for cross-platform duplicates.
      const rankWeight = 1 - (item.rank - 1) / Math.max(12, source.items.length);
      const popularity = item.heat == null ? rankWeight : (rankWeight + Math.sqrt(item.heat / maxHeat)) / 2;
      candidates.set(id, { ...item, id, source: source.id, popularity });
    }
  }
  return transaction(db, () => {
    const put = db.prepare(`INSERT INTO topics (account_id, id, title, source, heat, rank, first_seen, status, created_at, updated_at, url)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?)
      ON CONFLICT(account_id, id) DO UPDATE SET heat = excluded.heat, rank = excluded.rank,
      source = excluded.source, url = excluded.url, updated_at = excluded.updated_at WHERE topics.status = 'new'`);
    const kept = db.prepare('SELECT first_seen FROM topics WHERE account_id = ? AND id = ?');
    const refs = db.prepare('SELECT COUNT(*) AS count FROM "references" WHERE account_id = ? AND topic_id = ?');
    return [...candidates.values()].map((candidate) => {
      const { id, title, source, heat, rank, url } = candidate;
      put.run(ACCOUNT, id, title, source, heat, rank, time, time, time, url);
      return { ...candidate, firstSeen: Number(kept.get(ACCOUNT, id)?.first_seen), referenceCount: Number(refs.get(ACCOUNT, id)?.count) };
    });
  });
}

/** @param {Db} db @param {Digest} digest @param {number} started @param {number} finished @param {boolean} ok */
function keepDigest(db, digest, started, finished, ok) {
  transaction(db, () => {
    const rank = db.prepare('UPDATE topics SET score = ?, reason = ?, format = ?, updated_at = ? WHERE account_id = ? AND id = ?');
    for (const topic of digest.topics) rank.run(topic.score, topic.reason, topic.format, finished, ACCOUNT, topic.id);
    db.prepare(`INSERT INTO runs (account_id, id, job, started_at, finished_at, ok, error, result_json)
      VALUES (?, ?, 'trends-refresh', ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, id) DO UPDATE SET started_at = excluded.started_at, finished_at = excluded.finished_at,
      ok = excluded.ok, error = excluded.error, result_json = excluded.result_json`)
      .run(ACCOUNT, `today:${digest.date}`, started, finished, Number(ok), ok ? null : 'No fresh chart', JSON.stringify(digest));
  });
}

// Webhook markup and mentions cannot come from external headlines or from project titles.
const safeLine = (/** @type {string} */ s) => s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replaceAll('<', '＜').replaceAll('>', '＞');
const markdown = (/** @type {string} */ s) => safeLine(s).replace(/[\[\]#*_~`|\\]/gu, (char) => String.fromCharCode(char.charCodeAt(0) + 0xfee0));

/** @param {string} date @param {Recommendation[]} topics @param {SourceView[]} sources @param {string} workbenchUrl */
function messageLines(date, topics, sources, workbenchUrl) {
  const title = `今日选题 · ${date}`;
  const lines = topics.slice(0, 5).map((topic, index) => [
    `${index + 1}. ${safeLine(topic.title)}`,
    `热度：${topic.heat == null ? `第 ${topic.rank} 位` : topic.heat.toLocaleString('zh-CN')} · 推荐分 ${topic.score}`,
    safeLine(topic.reason),
    `建议：${safeLine(topic.format)}`,
    `openfilm://topic/${topic.id}`,
  ].join('\n'));
  if (!lines.length) lines.push('今天暂无符合时效的推荐选题。');
  const warnings = sources.filter(({ status }) => status === 'unavailable' || status === 'stale')
    .map(({ name, status }) => `${name}热榜${status === 'stale' ? '已过期' : '暂不可用'}`);
  if (warnings.length) lines.push(warnings.join('，'));
  if (workbenchUrl) lines.push(`本机工作台：${workbenchUrl}`);
  return { title, lines };
}

/** @param {typeof CHANNELS[number]} channel @param {ReturnType<typeof messageLines>} message */
function webhookPayload(channel, { title, lines }) {
  if (channel === 'feishu') return {
    msg_type: 'post', content: { post: { zh_cn: { title, content: lines.map((text) => [{ tag: 'text', text }]) } } },
  };
  // The text is limited before sending; WeCom limits Markdown content to 4096 UTF-8 bytes.
  const head = `## ${title}`;
  let content = head;
  for (const line of lines) {
    const part = line.split('\n').map(markdown).join('\n');
    if (Buffer.byteLength(content + '\n\n' + part) > 4000) break;
    content += '\n\n' + part;
  }
  return { msgtype: 'markdown', markdown: { content } };
}

/**
 * @param {{ getStore?: () => Promise<Db | null>, stateDir?: string, onChange?: () => void,
 *   workbenchUrl?: () => string, fetchFn?: typeof fetch, now?: () => number }} [options]
 */
export function createWorkbenchTrends({
  getStore = openWorkbench, stateDir = studioHome(), onChange = () => {}, workbenchUrl = () => '', fetchFn = fetch, now = Date.now,
} = {}) {
  const file = join(stateDir, 'workbench-providers.json');
  let controller = new AbortController();
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  let attempted = '';
  /** @type {Promise<Awaited<ReturnType<typeof read>>> | undefined} */
  let refreshing;
  /** @type {Promise<void> | undefined} */
  let ticking;

  async function requireStore() {
    const db = await getStore();
    if (!db) throw new HttpError(503, 'Workbench storage requires a Node runtime with SQLite');
    return db;
  }

  /** @param {Db} db @param {Source} source @param {AbortSignal} signal */
  async function refreshSource(db, source, signal) {
    const id = `hot-cache:${source.id}`;
    if (!claimRun(db, id, `hot-${source.id}`, now(), CACHE_TIME)) return;
    const attempts = [{ via: /** @type {const} */ ('direct'), ...source }, ...backupHotSources(source.id)];
    const timeout = Math.floor(TIMEOUT / attempts.length);
    /** @type {ChartCache | undefined} */
    let data;
    for (const { via, url, parse } of attempts) {
      if (signal.aborted) break;
      try {
        const response = await fetchFn(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]), redirect: 'error' });
        const chart = parse(await limitedJson(response, 2 << 20));
        const time = now();
        const observed = { ...chart, via, fetchedAt: new Date(time).toISOString() };
        data ??= observed;
        if (chartFresh(observed, time)) { data = observed; break; }
      } catch { /* The next configured source can still serve this chart. */ }
    }
    finishRun(db, id, now(), Boolean(data), data ? null : 'Hot chart unavailable', data);
  }

  /** @param {Db} db @param {string} date */
  function deliveries(db, date) {
    return Object.fromEntries(CHANNELS.map((channel) => {
      const run = readRun(db, `daily:${date}:${channel}`);
      return [channel, run ? { status: run.ok == null ? 'pending' : run.ok === 1 ? 'sent' : 'failed', error: run.error } : null];
    }));
  }

  async function read() {
    const db = await requireStore();
    const settings = await readSettings(file);
    const time = now();
    const [date] = localTime(time);
    const digest = /** @type {Digest | null} */ (resultOf(readRun(db, `today:${date}`)));
    return {
      date, generatedAt: digest?.generatedAt ?? null, ranking: digest?.ranking ?? 'heat',
      sources: hotSources.map((source) => sourceView(db, source, settings, time)),
      topics: (digest?.topics ?? []).filter(({ source }) => !settings.off.includes(source)),
      deliveries: deliveries(db, date),
    };
  }

  function refresh() {
    if (refreshing) return refreshing;
    const signal = controller.signal;
    refreshing = (async () => {
      signal.throwIfAborted();
      const db = await requireStore();
      const initial = await readSettings(file);
      const started = now();
      signal.throwIfAborted();
      await Promise.all(hotSources.filter(({ id }) => !initial.off.includes(id)).map((source) => refreshSource(db, source, signal)));
      signal.throwIfAborted();
      const settings = await readSettings(file);
      const time = now();
      const [date] = localTime(time);
      const sources = hotSources.map((source) => sourceView(db, source, settings, time));
      const candidates = keepCandidates(db, sources, time);
      const scored = await scoreHotTopics(candidates, candidates.length ? await listVideos(db) : [], time);
      signal.throwIfAborted();
      keepDigest(db, { date, generatedAt: new Date(time).toISOString(), ...scored }, started, now(), sources.some((source) => source.status === 'fresh'));
      onChange();
      return read();
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }

  /** @param {Db} db @param {string} id @param {typeof CHANNELS[number]} channel @param {URL} url @param {ReturnType<typeof messageLines>} message @param {AbortSignal} signal */
  async function send(db, id, channel, url, message, signal) {
    const key = `${id}:${channel}`;
    if (!claimRun(db, key, `webhook-${channel}`, now())) return true;
    try {
      const response = await fetchFn(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(webhookPayload(channel, message)), redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]),
      });
      const result = await limitedJson(response, 32 << 10);
      const code = channel === 'feishu' ? result?.code ?? result?.StatusCode : result?.errcode;
      if (code !== 0) throw new Error('Webhook did not accept the message');
      finishRun(db, key, now(), true, null);
      return true;
    } catch {
      finishRun(db, key, now(), false, 'Webhook did not accept the message');
      return false;
    }
  }

  async function runDaily() {
    const signal = controller.signal;
    const [date, time] = localTime(now());
    if (signal.aborted || time < '08:00' || attempted === date) return;
    const db = await getStore();
    if (!db) return;
    const id = `daily:${date}`;
    const settings = await readSettings(file);
    if (signal.aborted || hotSources.every((source) => settings.off.includes(source.id))) return;
    const claimed = claimRun(db, id, 'daily-topics', now());
    attempted = date;
    if (!claimed) return;
    try {
      const digest = await refresh();
      signal.throwIfAborted();
      if (digest.date !== date) throw new Error('The scheduled day ended');
      const current = await readSettings(file);
      signal.throwIfAborted();
      const message = messageLines(date, digest.topics, digest.sources, workbenchUrl());
      const results = await Promise.all(CHANNELS.map((channel) => {
        const { url } = destination(current, channel);
        return url ? send(db, id, channel, url, message, signal) : true;
      }));
      const ok = results.every(Boolean) && digest.sources.some((source) => source.status === 'fresh');
      finishRun(db, id, now(), ok, ok ? null : 'One or more daily trend tasks did not finish successfully');
      if (!signal.aborted) onChange();
    } catch {
      finishRun(db, id, now(), false, 'Daily trend job did not finish');
    }
  }

  function tick() {
    ticking ??= runDaily().finally(() => { ticking = undefined; });
    return ticking;
  }

  return {
    read, refresh, tick,
    settings: async () => publicSettings(await readSettings(file)),
    updateSettings: async (/** @type {unknown} */ input) => {
      const result = await updateTrendSettings(file, input);
      if (!controller.signal.aborted) onChange();
      return result;
    },
    start() {
      if (timer || process.env.NODE_TEST_CONTEXT) return;
      if (controller.signal.aborted) controller = new AbortController();
      const check = () => { void tick().catch(() => {}); };
      timer = setInterval(check, MINUTE);
      timer.unref();
      check();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      controller.abort();
      await Promise.allSettled([refreshing, ticking]);
    },
  };
}
