import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createViewer } from '../server.mjs';
import { openChrome } from '../tools/chrome.mjs';

const OUT = fileURLToPath(new URL('../.build/e2e/gallery/', import.meta.url));
const seen = [];
let dir;
let viewer;
let chrome;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dashboard-gallery-'));
  viewer = await createViewer({ key: null });
  await new Promise(done => viewer.listen(0, '127.0.0.1', done));
  chrome = await openChrome({ profile: join(dir, 'chrome'), origin: `http://127.0.0.1:${viewer.address().port}` });
  await mkdir(OUT, { recursive: true });
});

after(async () => {
  await writeFile(join(OUT, 'gallery.json'), JSON.stringify({ seen, thrown: chrome?.thrown }, null, 2));
  await chrome?.close();
  viewer?.closeAllConnections();
  await new Promise(done => viewer ? viewer.close(done) : done());
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('whole photos fit the gallery through stepping and resizing, and its picture opens the viewer', async () => {
  await chrome.size(1440, 900, 1);
  await chrome.load('kit-gallery.html#group=__none__', '');
  await chrome.until("document.querySelector('#main')?.dataset.galleryReady === '1'");
  await chrome.evaluate(`(async () => {
    const kit = await import('/ui/kit/gallery.js');
    const { keepPicture } = await import('/lib/api.js');
    window.testPictures = await Promise.all([[4032, 3024], [3024, 4032], [6000, 1000]].map(async ([width, height], index) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const paint = canvas.getContext('2d');
      paint.fillStyle = '#5b8496'; paint.fillRect(0, 0, width, height);
      paint.fillStyle = '#eccd87'; paint.fillRect(0, height / 2, width, height / 2);
      paint.strokeStyle = '#fff'; paint.lineWidth = 80; paint.strokeRect(40, 40, width - 80, height - 80);
      // Named by a hash, as the home names a picture, and kept on the page under it: pictureUrl's one rule draws it.
      const hash = 'sha256:' + String(index).repeat(64);
      keepPicture(hash, await new Promise(done => canvas.toBlob(done)));
      return { hash, alt: 'Synthetic photo ' + index, words: 'Whole photo ' + index };
    }));
    document.body.innerHTML = kit.gallery(window.testPictures);
    kit.installGalleries(document.body, () => window.testPictures);
  })()`);
  const fits = async (selector, holder) => {
    await chrome.until(`document.querySelector('${selector}')?.naturalWidth > 0`);
    await chrome.evaluate(`document.querySelector('${selector}').decode()`);
    const dimensions = await chrome.evaluate(`(() => {
      const image = document.querySelector('${selector}'), holder = document.querySelector('${holder}');
      const rect = image.getBoundingClientRect(), frame = holder.getBoundingClientRect();
      return { loaded: image.naturalWidth > 0, image: rect.toJSON(), frame: frame.toJSON(),
        contains: getComputedStyle(image).objectFit === 'contain', viewport: [innerWidth, innerHeight] };
    })()`);
    seen.push(dimensions);
    assert.ok(dimensions.loaded);
    assert.ok(dimensions.contains);
    const { image, frame, viewport } = dimensions;
    assert.ok(image.width > 0 && image.height > 0);
    assert.ok(image.top >= frame.top - 1 && image.bottom <= frame.bottom + 1, 'the whole photo fits vertically');
    assert.ok(image.left >= frame.left - 1 && image.right <= frame.right + 1, 'the whole photo fits horizontally');
    assert.ok(frame.left >= -1 && frame.right <= viewport[0] + 1, 'the frame stays within the window');
  };
  for (const [width, height] of [[1440, 900], [390, 844], [800, 450]]) {
    await chrome.size(width, height, 1);
    for (let index = 0; index < 3; index += 1) {
      await chrome.evaluate(`document.querySelector('[data-ck-gallery-at="${index}"]').click()`);
      await chrome.until(`document.querySelector('[data-ck-gallery]')?.dataset.ckGallery === '${index}'`);
      await fits('.ck-gallery__open img', '.ck-gallery__stage');
      assert.equal(await chrome.evaluate("document.querySelector('.ck-gallery__words').textContent"), `Whole photo ${index}`);
      assert.ok(await chrome.evaluate(`document.querySelector('.ck-gallery__line').getBoundingClientRect().right <= innerWidth + 1`));
      if (index < 2) await chrome.shoot(join(OUT, `${width}-${index}.png`));
    }
  }
  await chrome.size(1440, 900, 1);
  await chrome.evaluate("document.querySelector('.ck-gallery').focus()");
  await chrome.key('ArrowLeft');
  await chrome.until(`document.querySelector('[data-ck-gallery]')?.dataset.ckGallery === '1'`);
  assert.equal(await chrome.evaluate("document.querySelector('.ck-gallery__words').textContent"), 'Whole photo 1');
  await chrome.evaluate("document.querySelector('.ck-gallery__open').click()");
  await chrome.until(`document.querySelector('.ck-viewer .ck-viewer__stage img.is-loaded')`);
  assert.equal(await chrome.evaluate(`document.querySelector('.ck-viewer__stage img').dataset.src`),
    await chrome.evaluate(`document.querySelector('.ck-gallery__open img').dataset.src`));
  assert.equal(await chrome.evaluate("document.querySelector('.ck-viewer__count').textContent"), '2 of 3');
  seen.push({ opened: await chrome.evaluate("document.querySelector('.ck-viewer__count').textContent") });
  await chrome.press('Escape');
  await chrome.until(`!document.querySelector('.ck-viewer')`);
  assert.equal(await chrome.evaluate("document.activeElement.matches('.ck-gallery__open')"), true);
  assert.deepEqual(chrome.thrown, []);
});
