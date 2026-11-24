import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import type { HomeFolder } from "@lifestreamprotocol/core";
import { REPORT_FILE, SHOT_FILE, type RecordRef, type Report, type Shot } from "../feedback.js";

export function keptReport(folder: HomeFolder, id: string, at_ms: number, refs: RecordRef[], shot: { shot: Shot; bytes: Buffer } | null = null): Report {
  const report: Report = {
    id, at_ms, by: "macbook-pro-0001", device: "mac", about: { kind: "chat", chat: "1790000000000-abcdef", n: 2 }, refs, text: "A synthetic report.", email: null,
    attachments: [{ kind: "answer", title: "This answer", text: "Answer: [[Person 1]] rang.", counts: { person: 1 } }, { kind: "app", title: "App details", text: "Home: 1 (0000000000ab)\n", counts: {} }],
    screenshot: shot?.shot ?? null, state: "queued", tries: 1, next_ms: at_ms, sent_ms: null, why: null, sent_before_erasure: false,
  };
  if (shot !== null) folder.file(SHOT_FILE, join(folder.root, "feedback", id, "screenshot.jpg")).write(shot.bytes);
  folder.file(REPORT_FILE, join(folder.root, "feedback", id, "report.json")).write(Buffer.from(JSON.stringify(report)));
  return report;
}

export interface Filed {
  length: string | undefined;
  parts: Map<string, { text: string; bytes: Buffer; type: string }>;
}

export async function fakeWorker(): Promise<{ url: string; filed: Filed[]; refused: number; status: { code: number; retry?: string } }> {
  const filed: Filed[] = [];
  const status: { code: number; retry?: string } = { code: 201 };
  const worker = { url: "", filed, refused: 0, status };
  const server: Server = createServer((request, response) => {
    if (request.headers["x-lifestream-report"] !== "1" || request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined) {
      worker.refused += 1;
      response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => void (async () => {
      const form = await new Response(Buffer.concat(chunks), { headers: { "content-type": request.headers["content-type"] ?? "" } }).formData();
      const parts = new Map<string, { text: string; bytes: Buffer; type: string }>();
      for (const [name, value] of form.entries()) {
        const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(await value.arrayBuffer());
        parts.set(name, { text: bytes.toString("utf8"), bytes, type: typeof value === "string" ? "" : value.type });
      }
      filed.push({ length: request.headers["content-length"], parts });
      response.writeHead(status.code, { "content-type": "application/json", ...(status.code < 300 || status.retry === undefined ? {} : { "retry-after": status.retry }) });
      response.end(JSON.stringify(status.code < 300 ? { kept: true } : { error: "bad" }));
    })());
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  onTestFinished(() => new Promise<void>((done) => {
    server.closeAllConnections();
    server.close(() => done());
  }));
  worker.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/reports`;
  return worker;
}
