// @ts-check
import { until } from '../until.mjs';

/**
 * @param {{ url: string, token: string, heard: (block: string, event: any) => void }} options
 * @returns {Promise<{ close: () => void }>}
 */
export async function followDoor({ url, token, heard }) {
  const following = new AbortController();
  /** @type {string | null} */
  let last = null;
  let open = false;
  void (async () => {
    while (!following.signal.aborted) {
      try {
        const response = await fetch(`${url}/v1/feed`, { signal: following.signal,
          headers: { authorization: `Bearer ${token}`, ...(last === null ? {} : { 'last-event-id': last }) } });
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel();
          const seconds = Number(response.headers.get('retry-after'));
          await new Promise(done => setTimeout(done, (Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1_000));
          continue;
        }
        open = true;
        let text = '';
        for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (response.body)) {
          text += Buffer.from(chunk).toString('utf8');
          for (let end = text.indexOf('\n\n'); end >= 0; end = text.indexOf('\n\n')) {
            const block = text.slice(0, end + 2);
            text = text.slice(end + 2);
            last = /^id: ?(.*)$/mu.exec(block)?.[1] ?? last;
            const data = block.split('\n').find(line => line.startsWith('data: '));
            heard(block, data ? JSON.parse(data.slice('data: '.length)) : null);
          }
        }
      } catch {
      }
    }
  })();
  await until('the stand-in following the door’s feed', () => open);
  return { close: () => following.abort() };
}

/**
 * @returns {{ add: (response: import('node:http').ServerResponse) => void, relay: (block: string) => void,
 *   tell: (block: string) => void, followers: () => number, close: () => void }}
 */
export function feedOut() {
  /** @type {Set<import('node:http').ServerResponse>} */
  const feeds = new Set();
  /** @type {string[]} */
  const unsaid = [];
  return {
    add(response) {
      feeds.add(response);
      response.on('close', () => feeds.delete(response));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('retry: 200\n\n');
      for (const block of unsaid.splice(0)) response.write(block);
    },
    relay(block) {
      for (const feed of feeds) feed.write(block);
    },
    tell(block) {
      if (!feeds.size) return void unsaid.push(block);
      for (const feed of feeds) feed.write(block);
    },
    followers: () => feeds.size,
    close() {
      for (const feed of feeds) feed.destroy();
    },
  };
}
