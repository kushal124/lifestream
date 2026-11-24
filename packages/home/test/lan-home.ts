import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { connect, createServer as relayServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { identity } from "../lan.js";
import { askHome } from "../socket.js";
import { testDist } from "./bundle.js";
import { editSettings, testSocket } from "./folder.js";
import { ChildHome, makeRoot, removeRoot } from "./harness-root.js";
import { phoneBundle, startDoor, type DoorProcess } from "./support.js";

process.env.LIFESTREAM_TEST_DIST ??= (await testDist()).dist;
const scratch = mkdtempSync(join(tmpdir(), "lifestream-lan-home-"));
const machine = join(scratch, "machine");
mkdirSync(machine);
const interfaces = (bonjour: string, addresses: string[]) =>
  writeFileSync(join(machine, "machine.json"), JSON.stringify({ dnssd: join(machine, "no-dns-sd"), bonjour, addresses }));
interfaces("127.0.0.1", ["localhost"]);
const env = { LIFESTREAM_MACHINE_DIR: machine };

const root = makeRoot("lifestream-lan-home-root-", { sources: {} });
let door: DoorProcess = await startDoor({ root, tokens: {}, ids: {} }, env);
const home = new ChildHome(root);
home.start(undefined, { env });
await home.ready();
const sock = testSocket(root, machine);

const elsewhere = join(scratch, "impostor");
mkdirSync(join(elsewhere, "config"), { recursive: true });
let hits = 0;
const impostor = createServer(identity(elsewhere), (request, response) => {
  hits += 1;
  request.resume();
  response.writeHead(200, { "content-type": "application/json" }).end("{}");
});
await new Promise<void>((resolve) => impostor.listen(0, "127.0.0.1", resolve));

const lan = () => (JSON.parse(readFileSync(join(root, "config", "settings.json"), "utf8")) as { "door.lan_port": number })["door.lan_port"];

const relay = relayServer((socket) => {
  const onward = connect(lan(), "127.0.0.1");
  socket.pipe(onward).pipe(socket);
  socket.on("error", () => onward.destroy());
  onward.on("error", () => socket.destroy());
});
await new Promise<void>((resolve) => relay.listen(lan(), "::1", resolve));
const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
say({ ready: true, lan: lan(), door: door.url, impostor: (impostor.address() as AddressInfo).port });

let bundles = 0;
const commands: Record<string, (command: Record<string, unknown>) => Promise<unknown>> = {
  pair: () => askHome(sock, "pair", ["--account", "person-a@example.com"]),
  async interfaces(command) {
    interfaces(command.bonjour as string, command.addresses as string[]);
    return { bonjour: command.bonjour, addresses: command.addresses };
  },
  async bundle(command) {
    const unit = command.unit as string;
    const captured = { wall_rfc3339: "2026-08-31T10:00:00.125+05:30", wall_unix_seconds: 1_756_614_600, elapsed_seconds: 100 };
    const line = { domain: "location", kind: "lifecycle", sequence: command.seal as number, captured, payload: { event: "process_launch" } };
    const made = phoneBundle({ entries: { "location.jsonl": [line] }, custody: { [`location:local:${unit}`]: { seal: command.seal as number } }, second: (bundles += 1) });
    const path = join(scratch, `${made.id.replace(":", "-")}.zip`);
    writeFileSync(path, made.bytes);
    return { path, id: made.id };
  },
  async "move-lan"() {
    await door.stop();
    editSettings(root, { "door.lan_port": 0 });
    door = await startDoor({ root, tokens: {}, ids: {} }, env, Number(new URL(door.url).port));
    return { lan: lan() };
  },
  impostor: async () => ({ hits }),
};

let ending: Promise<void> | undefined;
function end(): Promise<void> {
  ending ??= (async () => {
    impostor.close();
    relay.close();
    await door.stop();
    await home.stop();
    removeRoot(root);
    rmSync(scratch, { recursive: true, force: true });
  })();
  return ending;
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => void end().then(() => process.exit(0)));

for await (const text of createInterface({ input: process.stdin })) {
  if (text.trim() === "") continue;
  const command = JSON.parse(text) as Record<string, unknown>;
  const name = command.do as string;
  try {
    say({ do: name, ok: true, value: await commands[name]!(command) });
  } catch (error) {
    say({ do: name, ok: false, error: (error as Error).message });
  }
}
await end();
process.exit(0);
