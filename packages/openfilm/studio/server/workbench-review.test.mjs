import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { filmHtml } from '../../src/film-doc.mjs';
import { openProject } from './projects.mjs';
import { addSnapshots } from './workbench-analytics.mjs';
import { generateReview, listHooks, listReview, saveHook, saveVariant } from './workbench-review.mjs';
import { closeWorkbench, openWorkbench, patchVideo } from './workbench-store.mjs';

const DAY = 86_400_000;

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'of-review-'));
  const env = {
    OPENFILM_HOME: join(dir, 'home'), OPENFILM_LIBRARY: join(dir, 'library'),
    OPENFILM_SHARED_HOME: join(dir, 'shared'), OPENAI_API_KEY: '', OPENFILM_OPENAI_URL: 'http://127.0.0.1:9',
  };
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    await closeWorkbench();
    await rm(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const project = await openProject(join(env.OPENFILM_LIBRARY, 'Review video'));
  await mkdir(join(project.path, 'assets'), { recursive: true });
  await writeFile(join(project.path, 'assets', 'cover.png'), 'picture');
  await writeFile(join(project.path, 'film.html'), filmHtml({
    tracks: [
      { clips: [{ id: 'intro', src: 'assets/secret-filename.png', at: 0, time: [0, 2] }] },
      { hidden: true, clips: [{ id: 'hidden', src: 'assets/hidden.png', at: 0, time: [0, 2] }] },
    ],
  }));
  const db = await openWorkbench();
  const video = await patchVideo(db, project.id, { platform: 'douyin', publishedAt: Date.now() - 9 * DAY, hook: 'Question', tags: ['How to'] });
  return { db, video };
}

test('hook saves are idempotent and A/B variants validate inputs before writing', async (t) => {
  const { db, video } = await fixture(t);
  assert.deepEqual(listHooks(db), { hooks: [] });
  const one = saveHook(db, { kind: ' Question ', text: 'Which version would you watch?' });
  assert.equal(one.hooks[0].kind, 'Question');
  assert.deepEqual(saveHook(db, { kind: 'Question', text: 'Which version would you watch?' }), one);
  assert.throws(() => saveHook(db, { kind: 'Question', text: ' ' }), { status: 400 });
  const { variants } = await saveVariant(db, video, {
    label: 'A', title: 'Version A', cover: 'assets/cover.png', impressions: 100, clicks: 12,
  });
  assert.equal(variants[0].clicks, 12);
  await assert.rejects(saveVariant(db, video, { label: 'A', title: 'Bad', impressions: 1, clicks: 12 }), { status: 400 });
  await assert.rejects(saveVariant(db, video, { label: 'B', cover: 'assets/../cover.png' }), { status: 400 });
  await assert.rejects(saveVariant(db, video, { label: 'B', cover: 'assets/missing.png' }), { status: 400 });
  assert.deepEqual((await listReview(db, video)).variants, variants);
});

test('review requires milestone evidence, sends only bounded context, and keeps a successful result after a model error', async (t) => {
  const { db, video } = await fixture(t);
  await assert.rejects(generateReview(db, video, {}), { status: 409, extra: { code: 'review-snapshot' } });
  const capturedAt = video.publishedAt + 7 * DAY - 3600_000;
  addSnapshots(db, video, { capturedAt, views: 42, likes: 5 });
  await assert.rejects(generateReview(db, video, {}), { status: 409, extra: { code: 'review-model' } });

  const calls = [];
  const report = { findings: 'T+7 reached 42 views.', hypotheses: 'The opening is one possible factor.', nextTest: 'Try a direct opening.' };
  let good = true;
  const service = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(good ? report : { findings: 'Incomplete' }) }] }],
    }));
  });
  await new Promise((done) => service.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => service.close(done)));
  process.env.OPENFILM_OPENAI_URL = `http://127.0.0.1:${service.address().port}`;
  process.env.OPENAI_API_KEY = 'review-fake-test-key';

  const writing = generateReview(db, video, { language: 'zh-CN', notes: 'Opening uses a question.' });
  await assert.rejects(generateReview(db, video, {}), { status: 409 });
  const { review } = await writing;
  assert.equal(review.capturedAt, capturedAt);
  assert.equal(review.findings, report.findings);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/v1/responses');
  assert.equal(calls[0].body.store, false);
  assert.match(calls[0].body.instructions, /Simplified Chinese/);
  const evidence = JSON.parse(calls[0].body.input);
  assert.deepEqual(evidence.timeline.map((clip) => clip.shot), ['intro']);
  assert.equal(evidence.milestones[2].metrics.views, 42);
  assert.equal(evidence.storyboardNotes, 'Opening uses a question.');
  assert.doesNotMatch(calls[0].body.input, /secret-filename|review-fake-test-key|projectPath/);

  good = false;
  await assert.rejects(generateReview(db, video, {}), { status: 502 });
  assert.deepEqual((await listReview(db, video)).review, review);
});
