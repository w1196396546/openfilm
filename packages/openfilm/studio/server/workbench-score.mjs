// @ts-check
/** Rank fresh public topics against the creator's own work. No project data leaves the machine. */
import { createHash } from 'node:crypto';
import { embedder, manifest } from '../../src/library-semantic.mjs';
import { libraryFile } from './library.mjs';

/** @typedef {import('./social/hot-sources.mjs').HotItem} HotItem */
/** @typedef {HotItem & { id: string, source: string, firstSeen: number, referenceCount: number, popularity: number }} Candidate */
/** @typedef {{ title: string, tags: string[], platform: string | null, durationS: number | null, publishedAt: number | null, latestSnapshot: { views: number | null } | null }} HistoryVideo */
/** @typedef {HotItem & { id: string, source: string, firstSeen: string, score: number, reason: string, format: string }} Recommendation */

const DAY = 86_400_000;
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const normalize = (/** @type {string} */ title) => title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
export const hotTopicId = (/** @type {string} */ title) => `hot-${createHash('sha256').update(normalize(title) || title).digest('hex').slice(0, 24)}`;

const terms = (/** @type {string} */ value) => new Set([...segmenter.segment(value.normalize('NFKC').toLowerCase())]
  .filter(({ isWordLike, segment }) => isWordLike && segment.length > 1).map(({ segment }) => segment));

/** @param {Set<string>} a @param {Set<string>} b */
function wordCosine(a, b) {
  const common = [...a].filter((word) => b.has(word)).length;
  return common ? common / Math.sqrt(a.size * b.size) : 0;
}

/** @param {Float32Array} a @param {Float32Array} b */
function modelCosine(a, b) {
  // E5 vectors are normalized and tend to have a high base cosine even for unrelated text.
  return Math.max(0, Math.min(1, (a.reduce((sum, x, i) => sum + x * b[i], 0) - 0.78) / 0.2));
}

/**
 * @param {Candidate[]} candidates
 * @param {HistoryVideo[]} history
 * @param {number} now
 * @returns {Promise<{ topics: Recommendation[], ranking: 'semantic' | 'keywords' | 'heat' }>}
 */
export async function scoreHotTopics(candidates, history, now) {
  const available = candidates.filter((candidate) => now - candidate.firstSeen < DAY);
  const measured = history.filter((video) => video.latestSnapshot?.views != null);
  const own = measured.filter((video) => video.platform === 'douyin');
  const baseline = own.length >= 2 ? own : measured;
  const views = baseline.map((video) => video.latestSnapshot?.views ?? 0).sort((a, b) => a - b);
  const median = (views[Math.floor((views.length - 1) / 2)] + views[Math.floor(views.length / 2)]) / 2;
  const best = baseline.filter((video) => (video.latestSnapshot?.views ?? 0) > median)
    .sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0)).slice(0, 24)
    .map((video) => ({ ...video, words: terms([video.title, ...video.tags].join(' ')) }));
  const model = available.length && best.length ? manifest() : null;
  /** @type {Map<string, Float32Array>} */
  const vectors = new Map();
  if (model?.files.every(({ path }) => libraryFile(path))) {
    try {
      const embed = await embedder(model);
      for (const candidate of available) vectors.set(candidate.id, await embed(`query: ${candidate.title}`));
      for (const [index, video] of best.entries()) vectors.set(String(index), await embed(`passage: ${[video.title, ...video.tags].join(' ')}`));
    } catch { vectors.clear(); }
  }
  // shortcut: use lexical cosine if local E5 files are absent, use the model when the library includes it.
  const ranking = vectors.size ? 'semantic' : best.length ? 'keywords' : 'heat';
  const topics = available.map(({ id, title, url, heat, rank, source, firstSeen, referenceCount, popularity }) => {
    const words = terms(title);
    const vector = vectors.get(id);
    /** @type {{ match: (typeof best)[number] | null, similarity: number }} */
    const noMatch = { match: null, similarity: 0 };
    const { match, similarity } = best.reduce((closest, video, index) => {
      const exemplar = vectors.get(String(index));
      const compared = vector && exemplar ? modelCosine(vector, exemplar) : wordCosine(words, video.words);
      return compared > closest.similarity ? { match: video, similarity: compared } : closest;
    }, noMatch);
    const reuse = match?.tags.find((tag) => normalize(tag).length > 1 && normalize(title).includes(normalize(tag)));
    const freshness = 1 - Math.max(0, now - firstSeen) / DAY;
    // The number of linked references is the observed competition; an unresearched topic leaves it out of the score.
    const weights = [
      [popularity, source === 'douyin' ? 0.44 : 0.38],
      ...(best.length ? [[similarity, 0.27], [reuse ? 1 : 0, 0.10]] : []),
      ...(referenceCount ? [[1 / (1 + referenceCount), 0.09]] : []),
      [freshness, 0.10],
    ];
    const score = Math.round(100 * weights.reduce((sum, [value, weight]) => sum + value * weight, 0) / weights.reduce((sum, [, weight]) => sum + weight, 0)
      * (source === 'douyin' ? 1 : 0.9));
    const similar = similarity >= 0.3 ? match : null;
    const reason = [
      `${source === 'douyin' ? '抖音' : '百度'}热榜第 ${rank} 位`,
      similar ? `与你的高表现作品《${similar.title.slice(0, 48)}》主题接近` : best.length ? '近期高表现作品中暂无相近题材' : '历史播放数据不足，先按热度与时效筛选',
      reuse ? `可从「${reuse.slice(0, 24)}」题材的已有素材找切入点` : '',
      referenceCount ? `已录入 ${referenceCount} 条对标` : '',
    ].filter(Boolean).join('。') + '。';
    const duration = similar?.durationS && similar.durationS >= 15 && similar.durationS <= 90 ? `约 ${Math.round(similar.durationS)} 秒` : '30–45 秒';
    const format = /如何|怎么|指南|教程/u.test(title) ? `${duration}步骤演示，先展示效果，再拆解做法`
      : /对比|争议|区别|讨论|热议/u.test(title) ? `${duration}正反对照，用一个具体场景解释差异`
        : `${duration}竖屏解说，先抛一个问题，再补两个关键背景`;
    return { id, title, url, heat, rank, source, firstSeen: new Date(firstSeen).toISOString(), score, reason, format };
  });
  return { topics: topics.sort((a, b) => b.score - a.score || a.rank - b.rank).slice(0, 5), ranking };
}
