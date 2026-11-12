// @ts-check
/** Public hot charts. The configured mirrors receive only fixed chart requests. */

/** @typedef {{ title: string, url: string | null, heat: number | null, rank: number }} HotItem */
/** @typedef {{ updatedAt: string | null, items: HotItem[] }} HotChart */

const DOUYIN = 'https://www.iesdouyin.com/web/api/v2/hotsearch/billboard/word/';
const BAIDU = 'https://top.baidu.com/api/board?platform=pc&tab=realtime';
const LIMIT = 12;
const chartLink = {
  douyin: (/** @type {string} */ title) => `https://www.douyin.com/search/${encodeURIComponent(title)}`,
  baidu: (/** @type {string} */ title) => `https://www.baidu.com/s?wd=${encodeURIComponent(title)}`,
};

export const hotSources = [
  { id: /** @type {const} */ ('douyin'), name: '抖音', url: DOUYIN, parse: douyinChart },
  { id: /** @type {const} */ ('baidu'), name: '百度', url: BAIDU, parse: baiduChart },
];

/** The timestamp of the board itself. `extra.now` on Douyin is the response time. @param {unknown} value */
function boardTime(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d{10,13}$/.test(value))) {
    const stamp = Number(value);
    const time = new Date(stamp < 1e12 ? stamp * 1000 : stamp);
    return Number.isFinite(time.valueOf()) ? time.toISOString() : null;
  }
  if (typeof value !== 'string') return null;
  const zoned = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + '+08:00' : value;
  const time = Date.parse(zoned);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** @param {unknown} value */
function hotValue(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

/** @param {unknown} value */
function hotTitle(value) {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, 140).replace(/[\uD800-\uDFFF]/gu, '\uFFFD') : '';
}

/** @param {any} data @returns {HotChart} */
function douyinChart(data) {
  if (data?.status_code !== 0 || !Array.isArray(data.word_list)) throw new Error('Douyin chart unavailable');
  const items = data.word_list.slice(0, LIMIT).flatMap((/** @type {any} */ item, /** @type {number} */ index) => {
    const title = hotTitle(item?.word);
    return title ? [{ title, url: chartLink.douyin(title), heat: hotValue(item.hot_value), rank: index + 1 }] : [];
  });
  if (!items.length) throw new Error('Douyin chart is empty');
  return { updatedAt: boardTime(data.active_time ?? data.updateTime), items };
}

/** @param {any} data @returns {HotChart} */
function baiduChart(data) {
  const list = data?.success && Array.isArray(data?.data?.cards)
    ? data.data.cards.find((/** @type {any} */ card) => card?.component === 'hotList')?.content : null;
  if (!Array.isArray(list)) throw new Error('Baidu chart unavailable');
  const items = list.slice(0, LIMIT).flatMap((/** @type {any} */ item, /** @type {number} */ index) => {
    const title = hotTitle(item?.word);
    return title ? [{ title, url: chartLink.baidu(title), heat: hotValue(item.hotScore), rank: index + 1 }] : [];
  });
  if (!items.length) throw new Error('Baidu chart is empty');
  return { updatedAt: boardTime(data.data.updateTime), items };
}

/**
 * A process-level choice of one trusted origin. Credentials, URL prefixes and redirects are outside this contract.
 * @param {string | undefined} value
 */
function mirrorOrigin(value) {
  try {
    const url = new URL(value ?? '');
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
    return url.href === url.origin + '/' ? url.origin : null;
  } catch { return null; }
}

/** @param {keyof typeof chartLink} id @param {any} list @param {unknown} time @returns {HotChart} */
function mirrorChart(id, list, time) {
  const updatedAt = boardTime(time);
  if (!Array.isArray(list) || !updatedAt) throw new Error('Mirrored chart is missing its items or timestamp');
  const items = list.slice(0, LIMIT).flatMap((/** @type {any} */ item, /** @type {number} */ index) => {
    const title = hotTitle(item?.title);
    return title ? [{ title, url: chartLink[id](title), heat: hotValue(item.hot), rank: index + 1 }] : [];
  });
  if (!items.length) throw new Error('Mirrored chart is empty');
  return { updatedAt, items };
}

/** @param {keyof typeof chartLink} id */
export function backupHotSources(id) {
  /** @type {{ via: 'newsnow' | 'dailyhot', url: string, parse: (data: any) => HotChart }[]} */
  const sources = [];
  const newsnow = mirrorOrigin(process.env.OPENFILM_NEWSNOW_ORIGIN);
  if (newsnow) sources.push({
    via: 'newsnow', url: `${newsnow}/api/s?id=${id}`,
    parse: (data) => {
      if (data?.id !== id || !['success', 'cache'].includes(data.status)) throw new Error('NewsNow chart unavailable');
      return mirrorChart(id, data.items, data.updatedTime);
    },
  });
  const dailyhot = mirrorOrigin(process.env.OPENFILM_DAILYHOT_ORIGIN);
  if (dailyhot) sources.push({
    via: 'dailyhot', url: `${dailyhot}/${id}`,
    parse: (data) => {
      if (data?.name !== id || data.code !== 200) throw new Error('DailyHotApi chart unavailable');
      return mirrorChart(id, data.data, data.updateTime);
    },
  });
  return sources;
}

/** Read only a bounded body from public and webhook endpoints. @param {Response} response @param {number} maxBytes */
export async function limitedJson(response, maxBytes) {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Remote response unavailable');
  }
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) throw new Error('Remote response is too large');
      parts.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(parts, size).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
