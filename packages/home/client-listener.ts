import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const LISTEN_MS = 10 * 60_000;

const CLOSE_PAGE = "<!doctype html><meta charset=\"utf-8\"><title>Lifestream</title><p style=\"font: 16px -apple-system, sans-serif; margin: 3em\">You can close this page.</p>\n";

interface Listening {
  server: Server | null;
  address: string | undefined;
  timer: NodeJS.Timeout;
}

export class ClientListeners {
  readonly #by = new Map<string, Listening>();
  readonly #spent = new Map<string, { words: string; timer: NodeJS.Timeout }>();

  async open(state: string): Promise<number> {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const held = this.#by.get(state);
      if (request.method !== "GET" || url.searchParams.get("state") !== state || held === undefined) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found\n");
        return;
      }
      held.address = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(CLOSE_PAGE, () => this.#stop(held));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const timer = setTimeout(() => this.#forget(state), LISTEN_MS);
    timer.unref();
    this.#by.set(state, { server, address: undefined, timer });
    return port;
  }

  caught(state: string): string | undefined {
    return this.#by.get(state)?.address;
  }

  spend(state: string, words: string): void {
    clearTimeout(this.#spent.get(state)?.timer);
    const timer = setTimeout(() => this.#spent.delete(state), LISTEN_MS);
    timer.unref();
    this.#spent.set(state, { words, timer });
  }

  spent(state: string): string | undefined {
    return this.#spent.get(state)?.words;
  }

  close(): void {
    for (const state of [...this.#by.keys()]) this.#forget(state);
    for (const { timer } of this.#spent.values()) clearTimeout(timer);
    this.#spent.clear();
  }

  #forget(state: string): void {
    const held = this.#by.get(state);
    if (held === undefined) return;
    clearTimeout(held.timer);
    this.#stop(held);
    this.#by.delete(state);
  }

  #stop(held: Listening): void {
    held.server?.close();
    held.server?.closeAllConnections();
    held.server = null;
  }
}
