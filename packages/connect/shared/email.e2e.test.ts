import { artifact, collect, temp } from "../test/drive.js";
import { describe, expect, it } from "vitest";
import { mboxMessages, readHeaders } from "./email.js";
import { Refused } from "./refused.js";

const crlf = (lines: (string | Buffer)[]): Buffer =>
  Buffer.concat(lines.flatMap((line) => [typeof line === "string" ? Buffer.from(line, "utf8") : line, Buffer.from("\r\n")]));

const b64 = (bytes: Buffer): string => bytes.toString("base64").replace(/.{1,20}/gu, "$&\r\n").trimEnd();

function message(): Buffer {
  const forwarded = crlf([
    "From: Person B <person-b@example.com>",
    "Subject: =?ISO-8859-1?Q?Caf=E9_receipt?=",
    "Content-Type: text/plain; charset=koi8-r",
    "Content-Transfer-Encoding: 8bit",
    "",
    Buffer.from([0xf0, 0xd2, 0xc9, 0xd7, 0xc5, 0xd4]),
  ]).subarray(0, -2);
  return crlf([
    "Return-Path: <person-a@example.com>",
    "X-GM-THRID: 1790000000000000001",
    "From: =?UTF-8?B?UGVyc29uIEEg8J+YgA==?= <person-a@example.com>",
    "To: person-b@example.com,",
    "\tperson-c@example.com",
    "Subject: =?utf-8?q?Fake_invoice_=E2=82=AC12?= =?utf-8?q?=2E50?=",
    Buffer.concat([Buffer.from("X-Note: caf"), Buffer.from([0xe9]), Buffer.from(" latin-1 bytes")]),
    "Date: Sat, 03 Oct 2026 14:00:00 +0530",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="outer boundary"',
    "",
    "This is the preamble; no reader shows it.",
    "--outer boundary",
    "Content-Type: multipart/alternative; boundary=inner",
    "",
    "--inner",
    "Content-Type: text/plain; charset=iso-8859-1",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Caf=E9 bill, total =3D 12,50 =",
    "soft-broken line",
    "--inner",
    "Content-Type: text/html; charset=windows-1252",
    "Content-Transfer-Encoding: base64",
    "",
    b64(Buffer.from([0x3c, 0x70, 0x3e, 0x80, 0x31, 0x32, 0x3c, 0x2f, 0x70, 0x3e])),
    "--inner--   ",
    "--outer boundary",
    "Content-Type: text/plain; charset=shift_jis",
    "Content-Transfer-Encoding: base64",
    "",
    b64(Buffer.from([0x82, 0xa0, 0x82, 0xa2])),
    "--outer boundary",
    "Content-Type: text/plain; charset=iso-2022-jp",
    "",
    Buffer.from("\x1b$B$\"$$\x1b(B", "latin1"),
    "--outer boundary",
    "Content-Type: application/pdf; name*0*=UTF-8''Rechnung%20M%C3%A4rz; name*1=\".pdf\"",
    "Content-Disposition: attachment; filename=\"invoice \\\"march\\\".pdf\"",
    "Content-Transfer-Encoding: base64",
    "",
    b64(Buffer.from("%PDF-1.4 fake pdf bytes")),
    "--outer boundary",
    "Content-Type: text/plain; charset=x-made-up",
    "",
    "bytes no decoder knows",
    "--outer boundary",
    "Content-Type: message/rfc822",
    "",
    forwarded,
    "--outer boundary--",
    "The epilogue; no reader shows it either.",
  ]);
}

describe("email parsing: each of these is impossible", () => {
  it("a header value is translated rather than kept, or a body is read as headers", () => {
    const dir = temp();
    const headers = readHeaders(message());
    expect(headers.get("subject")).toBe("=?utf-8?q?Fake_invoice_=E2=82=AC12?= =?utf-8?q?=2E50?=");
    expect(headers.fields.find((header) => header.name === "X-GM-THRID")?.value).toBe("1790000000000000001");
    expect(headers.get("to")).toBe("person-b@example.com,\tperson-c@example.com");
    expect(headers.fields.find((header) => header.name === "To")?.raw).toBe("To: person-b@example.com,\r\n\tperson-c@example.com");
    expect(Buffer.from(headers.get("x-note")!, "latin1")).toEqual(Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from(" latin-1 bytes")]));
    expect(headers.fields.map((header) => header.name)).toEqual(["Return-Path", "X-GM-THRID", "From", "To", "Subject", "X-Note", "Date", "MIME-Version", "Content-Type"]);
    expect(readHeaders(Buffer.from("Subject: no body")).get("subject")).toBe("no body");
    artifact(dir, "headers.json", { headers: headers.fields });
  });

  it("an mbox splits a message at a body line that starts with From, or changes its bytes", async () => {
    const dir = temp();
    const first = crlf([
      "X-GM-THRID: 1790000000000000001",
      "Subject: first",
      "",
      "From the desk of person A: this line is body, not a delimiter.",
      ">From quoted, kept as it is.",
      "",
    ]);
    const second = crlf(["X-GM-THRID: 1790000000000000002", "Subject: second", "", "body two", ""]);
    const mbox = Buffer.concat([
      Buffer.from("From 1790000000000000011@xxx Sat Oct 03 08:30:00 +0000 2026\r\n"),
      first,
      Buffer.from("From 1790000000000000012@xxx Sat Oct 03 08:31:00 +0000 2026\r\n"),
      second,
    ]);
    const chunks = (size: number): Buffer[] => {
      const out: Buffer[] = [];
      for (let at = 0; at < mbox.length; at += size) out.push(mbox.subarray(at, at + size));
      return out;
    };
    const collect = async (size: number) => {
      const out = [];
      for await (const message of mboxMessages(chunks(size))) out.push(message);
      return out;
    };
    for (const size of [1, 7, 64, mbox.length]) {
      const messages = await collect(size);
      expect(messages.map((item) => item.from_line)).toEqual([
        "From 1790000000000000011@xxx Sat Oct 03 08:30:00 +0000 2026",
        "From 1790000000000000012@xxx Sat Oct 03 08:31:00 +0000 2026",
      ]);
      expect(messages[0]!.bytes).toEqual(first);
      expect(messages[1]!.bytes).toEqual(second);
      expect(mbox.subarray(messages[1]!.offset, messages[1]!.offset + second.length)).toEqual(second);
    }
    let refused = "";
    try {
      for await (const _message of mboxMessages([Buffer.from("not an mbox\r\nFrom nobody\r\n")])) break;
    } catch (error) {
      refused = error instanceof Refused ? error.message : "threw";
    }
    expect(refused).toBe("the mbox does not begin with a delimiter line");
    const messages = (await collect(64)).map((item) => ({ from_line: item.from_line, offset: item.offset, bytes: item.bytes.length }));
    artifact(dir, "mbox.json", { messages, refused });
  });
});
