import { Writable } from "node:stream";
import { createInterface } from "node:readline";
import { fail } from "./verbs/context.js";

export interface SecretAsk {
  readonly label: string;
  readonly piped: string;
  readonly macApp: boolean;
}

export async function secretInput(ask: SecretAsk, stdin: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin): Promise<string> {
  let text: string;
  if (stdin.isTTY === true) {
    if (ask.macApp) fail(`${ask.label} is not typed at a terminal on a Mac with the Lifestream app: its screen recorder and input log would keep it. Pipe it in: ${ask.piped}`);
    process.stderr.write(`${ask.label} (not shown), then Return: `);
    const silent = new Writable({ write: (_chunk, _encoding, done) => done() });
    const lines = createInterface({ input: stdin, output: silent, terminal: true });
    try {
      text = await new Promise<string>((done, stopped) => {
        lines.once("SIGINT", () => stopped(new Error(`no ${ask.label}: typing it was stopped`)));
        lines.question("", done);
      });
    } finally {
      lines.close();
      process.stderr.write("\n");
    }
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    text = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/u, "");
  }
  if (text === "") fail(`standard input held no ${ask.label}: ${ask.piped}`);
  return text;
}
