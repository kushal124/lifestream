import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../server.mjs';
import { openDoor } from '../lib/door.mjs';

const REPO = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PAGE_MS = 500;
const measured = {};
let child;
let home;
let dashboard;
let dir;
let url;
let started;
const waiting = [];
const waits = [];

async function command(cmd, more = {}) {
  const answer = new Promise(done => waiting.push(done));
  child.stdin.write(`${JSON.stringify({ cmd, ...more })}\n`);
  const line = await answer;
  assert.equal(line.ok, true, line.error);
  return line.value;
}

async function deck() {
  const asked = performance.now();
  const response = await fetch(`${url}/api/faces`);
  const body = await response.json();
  waits.push(performance.now() - asked);
  assert.equal(response.status, 200, JSON.stringify(body));
  return body;
}

async function until(ready) {
  const from = performance.now();
  for (;;) {
    const answer = await deck();
    if (ready(answer)) return { ms: performance.now() - from, answer };
    await new Promise(done => setTimeout(done, 50));
  }
}

before(async () => {
  const building = performance.now();
  child = spawn(process.execPath, ['--import', 'tsx', '--import', './testing/process.mjs', join('packages', 'home', 'test', 'dashboard-home.ts'), 'scale'], {
    cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout });
  home = await new Promise((done, fail) => {
    child.once('exit', code => fail(new Error(`the scale home exited with ${code}`)));
    lines.on('line', text => {
      const line = JSON.parse(text);
      if (line.ready) done(line);
      else waiting.shift()?.(line);
    });
  });
  measured.home_built_ms = Math.round(performance.now() - building);
  dir = await mkdtemp(join(tmpdir(), 'dashboard-scale-'));
  started = performance.now();
  dashboard = await createViewer({ door: openDoor({ url: home.url, token: () => home.tokens.dashboard }) });
  await new Promise(done => dashboard.listen(0, '127.0.0.1', done));
  url = `http://127.0.0.1:${dashboard.address().port}`;
});

after(async () => {
  await new Promise(done => dashboard?.close(done));
  if (child) await command('stop').catch(() => undefined);
  if (dir) await rm(dir, { recursive: true, force: true });
  measured.longest_wait_ms = Math.round(Math.max(...waits));
  measured.deck_requests = waits.length;
  const out = join(tmpdir(), 'lifestream-e2e');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'dashboard-faces-scale.json'), `${JSON.stringify(measured, null, 2)}\n`);
  process.stdout.write(`# faces deck at scale: ${JSON.stringify(measured)}\n`);
});

test('S1 S2: the first read at the dashboard\'s start makes a page wait, or reads more than the conclusions', async () => {
  const pages = [];
  for (const kind of ['cluster', 'named']) {
    const asked = performance.now();
    const response = await fetch(`${home.url}/v1/records?source=${encodeURIComponent('faces:local:macbook-pro-0001')}&kind=${kind}&limit=1024`,
      { headers: { authorization: `Bearer ${home.tokens.dashboard}` } });
    await response.json();
    pages.push([kind, Math.round(performance.now() - asked)]);
  }
  measured.door_page_ms = Object.fromEntries(pages);
  const first = await deck();
  assert.equal(first.ready, false);
  assert.equal(first.building, true);
  const ready = await until(answer => answer.ready);
  measured.first_read_ms = Math.round(performance.now() - started);
  measured.first_read_server_ms = ready.answer.took_ms;
  measured.first_read_records = ready.answer.progress.total;
  assert.ok(ready.answer.cards.length > 0);
  const counted = await fetch(`${home.url}/v1/counts?source=${encodeURIComponent('faces:local:macbook-pro-0001')}&kind=cluster&kind=named`,
    { headers: { authorization: `Bearer ${home.tokens.dashboard}` } });
  const { counts } = await counted.json();
  assert.equal(ready.answer.progress.total, counts.cluster + counts.named);
  assert.ok(Math.max(...waits) < PAGE_MS, `a page waited ${Math.max(...waits)} ms`);
});

test('S1 S3: a labeler delivery makes a page wait, or is never read', async () => {
  const before_ = await deck();
  assert.equal(before_.ready, true);
  const asked = performance.now();
  const delivery = await command('faces-delivery', { round: 1 });
  measured.delivery_lines = delivery.lines;
  measured.delivery_imported_ms = Math.round(performance.now() - asked);
  const read = await until(answer => answer.position !== before_.position && !answer.building);
  measured.reread_ms = Math.round(performance.now() - asked);
  measured.reread_server_ms = read.answer.took_ms;
  assert.ok(Math.max(...waits) < PAGE_MS, `a page waited ${Math.max(...waits)} ms`);
});
