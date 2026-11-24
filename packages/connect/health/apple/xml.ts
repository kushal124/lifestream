import { refuse } from "@lifestreamprotocol/connect/sdk";

export interface XmlElement {
  name: string;
  attributes: Map<string, string>;
  children: XmlElement[];
}

const NAME = /[A-Za-z_][A-Za-z0-9_.:-]*/uy;
const ATTRIBUTE = /[ \t\r\n]*([A-Za-z_][A-Za-z0-9_.:-]*)[ \t\r\n]*=[ \t\r\n]*(?:"([^"]*)"|'([^']*)')/uy;
const NOT_SPACE = /[^ \t\r\n]/u;
const DELIMITER = /["'>]/gu;

export async function* rootChildren(chunks: AsyncIterable<Buffer> | Iterable<Buffer>, root: string): AsyncGenerator<XmlElement> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (chunk?: Buffer): string => {
    try {
      return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true });
    } catch {
      return refuse("export.xml is not UTF-8");
    }
  };
  const open: XmlElement[] = [];
  let rootSeen = false;
  let rootClosed = false;
  let text = "";
  let at = 0;

  function* scan(final: boolean): Generator<XmlElement> {
    for (;;) {
      const lt = text.indexOf("<", at);
      const between = lt === -1 ? text.slice(at) : text.slice(at, lt);
      if (NOT_SPACE.test(between)) refuse(open.length === 0 ? "character data outside the root element" : `character data inside <${open.at(-1)!.name}>`);
      if (lt === -1) {
        at = text.length;
        return;
      }
      at = lt;
      const end = constructEnd(text, lt, final);
      if (end === undefined) return;
      const construct = Buffer.from(text.slice(lt, end)).toString();
      at = end;
      if (construct.startsWith("<?") || construct.startsWith("<!--")) continue;
      if (construct.startsWith("<!DOCTYPE")) {
        if (rootSeen) refuse("a DOCTYPE inside the document");
        continue;
      }
      if (construct.startsWith("<!")) refuse(`an XML construct the export does not write: ${construct.slice(0, 12)}`);
      if (construct.startsWith("</")) {
        const name = construct.slice(2, -1).trim();
        const element = open.pop();
        if (element === undefined || element.name !== name) refuse(`</${name}> closes ${element === undefined ? "nothing" : `<${element.name}>`}`);
        if (open.length === 0) rootClosed = true;
        else if (open.length === 1) yield element;
        else open.at(-1)!.children.push(element);
        continue;
      }
      const element = tag(construct);
      const selfClosing = construct.endsWith("/>");
      if (open.length === 0) {
        if (rootSeen || element.name !== root) refuse(`the document must hold one <${root}> root`);
        if (selfClosing) refuse(`<${root}> holds nothing`);
        rootSeen = true;
        open.push(element);
      } else if (selfClosing) {
        if (open.length === 1) yield element;
        else open.at(-1)!.children.push(element);
      } else {
        open.push(element);
      }
    }
  }

  for await (const chunk of chunks) {
    text = text.slice(at) + decode(chunk);
    at = 0;
    yield* scan(false);
  }
  text = text.slice(at) + decode();
  at = 0;
  yield* scan(true);
  if (!rootSeen || !rootClosed) refuse(`export.xml ended before <${root}> closed`);
}

function constructEnd(text: string, lt: number, final: boolean): number | undefined {
  const more = (): undefined => (final ? refuse(`export.xml ends inside a construct at ${JSON.stringify(text.slice(lt, lt + 20))}`) : undefined);
  const rest = text.length - lt;
  for (const opener of ["<!--", "<?", "<!DOCTYPE"]) {
    if (rest < opener.length && opener.startsWith(text.slice(lt))) return more();
  }
  if (text.startsWith("<!--", lt)) {
    const end = text.indexOf("-->", lt + 4);
    return end === -1 ? more() : end + 3;
  }
  if (text.startsWith("<?", lt)) {
    const end = text.indexOf("?>", lt + 2);
    return end === -1 ? more() : end + 2;
  }
  if (text.startsWith("<!DOCTYPE", lt)) {
    let quote: string | undefined;
    let depth = 0;
    for (let i = lt + 9; i < text.length; i++) {
      const c = text[i]!;
      if (quote !== undefined) {
        if (c === quote) quote = undefined;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === "[") depth++;
      else if (c === "]") depth--;
      else if (c === ">" && depth === 0) return i + 1;
    }
    return more();
  }
  DELIMITER.lastIndex = lt + 1;
  for (;;) {
    const found = DELIMITER.exec(text);
    if (found === null) return more();
    if (found[0] === ">") return found.index + 1;
    const close = text.indexOf(found[0], found.index + 1);
    if (close === -1) return more();
    DELIMITER.lastIndex = close + 1;
  }
}

function tag(construct: string): XmlElement {
  const body = construct.slice(1, construct.endsWith("/>") ? -2 : -1);
  NAME.lastIndex = 0;
  const name = NAME.exec(body)?.[0];
  if (name === undefined) refuse(`a tag without a name: ${construct.slice(0, 20)}`);
  const attributes = new Map<string, string>();
  let at = name.length;
  for (;;) {
    ATTRIBUTE.lastIndex = at;
    const found = ATTRIBUTE.exec(body);
    if (found === null) break;
    if (attributes.has(found[1]!)) refuse(`<${name}> repeats the attribute ${found[1]}`);
    attributes.set(found[1]!, entities(found[2] ?? found[3]!));
    at = ATTRIBUTE.lastIndex;
  }
  if (NOT_SPACE.test(body.slice(at))) refuse(`<${name}> holds something that is not an attribute: ${body.slice(at, at + 20)}`);
  return { name, attributes, children: [] };
}

function entities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/gu, (_, body: string) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    const code = body.startsWith("#x") ? Number.parseInt(body.slice(2), 16) : body.startsWith("#") ? Number.parseInt(body.slice(1), 10) : Number.NaN;
    if (!Number.isSafeInteger(code) || code > 0x10ffff) refuse(`an entity the export does not write: &${body};`);
    return String.fromCodePoint(code);
  });
}
