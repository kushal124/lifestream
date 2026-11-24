import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectorGives, connectorIcon, connectorName, declarations, PHONE_SCREENS, type Connector, type PhoneGrant } from "@lifestreamprotocol/connect";
import { ALLOWED } from "../packages/home/stated.js";
import { grantWord } from "../packages/home/stream-words.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "ios-app", "LifestreamCapture", "Connectors", "Declared.swift");

const camel = (name: string): string => name.replace(/-([a-z0-9])/gu, (_, c: string) => c.toUpperCase());

function quoted(text: string): string {
  if (/[\u0000-\u001f\\]/u.test(text)) throw new Error(`phone-words: ${JSON.stringify(text)} holds a control character or a backslash`);
  return `"${text.replaceAll('"', '\\"')}"`;
}

function faults(connectors: readonly Connector[]): string[] {
  return connectors.flatMap((connector) => {
    const { grants, misses, why } = connector.phone!;
    if (grants.length > 1) return [`${connector.id}: its phone copy runs on ${grants.join(", ")}; a phone source runs on one grant`];
    const screen = grants.some((grant) => PHONE_SCREENS.includes(grant));
    const said = [["misses", misses, "what the days miss"], ["why", why, "why its screen asks"]] as const;
    return said.flatMap(([member, words, what]) => {
      if (screen && words === undefined) return [`${connector.id}: its grant has a first-run screen, so its phone block says ${what} (\`${member}\`)`];
      if (!screen && words !== undefined) return [`${connector.id}: no first-run screen asks its grant, so nothing says ${what} (\`${member}\`)`];
      return [];
    });
  });
}

function swift(connectors: readonly Connector[]): string {
  const stream = (connector: Connector): string => {
    const noun = connector.noun === undefined ? "nil" : `(${quoted(connector.noun[0])}, ${quoted(connector.noun[1])})`;
    const { grants: [grant], misses, why } = connector.phone!;
    const said = (words: string | undefined): string => (words === undefined ? "nil" : quoted(words));
    return `    static let ${camel(connector.id)} = DeclaredStream(id: ${quoted(connector.id)}, name: ${quoted(connectorName(connector))}, `
      + `icon: .${camel(connectorIcon(connector))},\n        gives: ${quoted(connectorGives(connector))}, noun: ${noun},\n`
      + `        grant: ${said(grant)}, misses: ${said(misses)},${why === undefined ? " " : "\n        "}why: ${said(why)})`;
  };
  const grant = (each: PhoneGrant): string[] => [
    `        ${quoted(each)}: [`,
    ...ALLOWED.map((state) => `            .${camel(state)}: ${quoted(grantWord(each, state))},`),
    "        ],",
  ];
  return [
    "import Cockpit",
    "",
    "struct DeclaredStream {",
    "    let id: String",
    "    let name: String",
    "    let icon: Cockpit.Icon",
    "    let gives: String",
    "    let noun: (String, String)?",
    "    let grant: String?",
    "    let misses: String?",
    "    let why: String?",
    "}",
    "",
    "extension DeclaredStream {",
    ...connectors.map(stream),
    "}",
    "",
    "enum GrantWords {",
    "    static let all: [String: [PermissionsModel.Stated: String]] = [",
    ...[...new Set(connectors.flatMap((connector) => connector.phone!.grants))].sort().flatMap(grant),
    "    ]",
    "}",
    "",
  ].join("\n");
}

const connectors = declarations().filter((connector) => connector.phone !== undefined && connector.hidden !== true);
const found = faults(connectors);
if (found.length > 0) {
  console.error(`phone-words: ${found.length} declaration(s) the phone cannot say:\n${found.join("\n")}`);
  process.exit(1);
}
const text = swift(connectors);
if (process.argv.includes("--check")) {
  const stale = (() => { try { return readFileSync(OUT, "utf8") !== text; } catch { return true; } })();
  if (stale) console.error(`phone-words: ${OUT.slice(ROOT.length + 1)} is not what the declarations make; run npx tsx tools/phone-words.ts`);
  process.exit(stale ? 1 : 0);
}
writeFileSync(OUT, text);
console.log(`phone-words: wrote ${OUT.slice(ROOT.length + 1)}`);
