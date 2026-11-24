import { describe, expect, it } from "vitest";
import type { PassageMark } from "./detector.js";
import { fitted } from "./fits.js";

function at(passage: string, words: string, n = 1): { start: number; end: number } {
  let start = -1;
  for (let found = 0; found < n; found += 1) start = passage.indexOf(words, start + 1);
  if (start === -1) throw new Error(`no ${words} in the passage`);
  return { start, end: start + words.length };
}

function fit(passage: string, marks: readonly (readonly [string, PassageMark["type"], number?])[], named: readonly string[] = []): string[] {
  const found = marks.map(([words, type, n]): PassageMark => ({ ...at(passage, words, n), type }));
  return fitted(passage, found, named.map((words) => at(passage, words))).map((mark) => `${mark.type}:${passage.slice(mark.start, mark.end)}`);
}

describe("a person", () => {
  it("is kept as the model found it: capitalised, a plain word, in lower case", () => {
    expect(fit("Lunch with Zorvan Example tomorrow.", [["Zorvan Example", "person"]])).toEqual(["person:Zorvan Example"]);
    expect(fit("Rose came by.", [["Rose", "person"]])).toEqual(["person:Rose"]);
    expect(fit("You: ram ko bhi bula lena", [["ram", "person"]])).toEqual(["person:ram"]);
  });
  it("is kept as a short word of capitals that can be a name; a word with no vowel or a lone letter is dropped, unless a cue or People names it", () => {
    expect(fit("RAVI said hi", [["RAVI", "person"]])).toEqual(["person:RAVI"]);
    expect(fit("your PNR is ready", [["PNR", "person"]])).toEqual([]);
    expect(fit("pay the GST today", [["GST", "person"]])).toEqual([]);
    expect(fit("signed J today", [["J", "person"]])).toEqual([]);
    expect(fit("Dear Brn, hello", [["Brn", "person"]], ["Brn"])).toEqual(["person:Brn"]);
  });
  it("in lower case is dropped when it holds a common word that is no given name and no word of address: a sentence's words", () => {
    expect(fit("Zorvan: gpay kar de zorvan@okbank pe", [["gpay kar de", "person"]])).toEqual([]);
    expect(fit("otp aaya 203650 bata de jaldi", [["jaldi", "person"]])).toEqual([]);
    expect(fit("Chennai 600042, rent is 32000", [["rent", "person"]])).toEqual([]);
    expect(fit("bol do zorvan bhai ko", [["zorvan bhai", "person"]])).toEqual(["person:zorvan bhai"]);
    expect(fit("You: will ko bhi bula lena", [["will", "person"]])).toEqual(["person:will"]);
  });
  it("in lower case is trimmed of a sentence's words spilled at its edges, and judged on what is left", () => {
    expect(fit("ravi se baat karo", [["ravi se", "person"]])).toEqual(["person:ravi"]);
    expect(fit("aaj priya aayegi", [["aaj priya", "person"]])).toEqual(["person:priya"]);
    expect(fit("aaj ravi bhai aayega", [["aaj ravi bhai", "person"]])).toEqual(["person:ravi bhai"]);
    expect(fit("aaj zorvan aayega", [["aaj zorvan", "person"]], ["zorvan"])).toEqual(["person:zorvan"]);
    expect(fit("ram se baat karo", [["ram se", "person"]])).toEqual(["person:ram"]);
    expect(fit("aaj kal aayenge sab", [["kal", "person"]])).toEqual(["person:kal"]);
    expect(fit("aaj kal aayenge sab", [["aaj kal", "person"]])).toEqual(["person:kal"]);
    expect(fit("aaj zorvan aayega", [["aaj zorvan", "person"]])).toEqual(["person:zorvan"]);
    expect(fit("aaj jaldi aa", [["aaj jaldi", "person"]])).toEqual([]);
    expect(fit("Zorvan: gpay kar de zorvan@okbank pe", [["gpay kar de", "person"]])).toEqual([]);
  });
  it("is dropped as words of no vowel alone, or an id's or a payment's name", () => {
    expect(fit("Credit card XXXX XXXX 6775", [["XXXX XXXX", "person"]])).toEqual([]);
    expect(fit("PAN\nABCPE0000Z\nAadhaar\n9999 0000 0000", [["Aadhaar", "person"]])).toEqual([]);
    expect(fit("credited by NEFT from EXAMPLE PVT LTD", [["NEFT", "person"]])).toEqual([]);
    expect(fit("at EXAMPLE on 03-06-2026. Avl Lmt: Rs 4054.35", [["Avl Lmt", "person"]])).toEqual([]);
    expect(fit("UHID\n4417-2231", [["UHID", "person"]])).toEqual([]);
    expect(fit("show your Passport here", [["Passport", "person"]])).toEqual([]);
    expect(fit("Call Ng Wei today", [["Ng Wei", "person"]])).toEqual(["person:Ng Wei"]);
  });
  it("as one capitalised common word is dropped when it is no given name, no family name and no name People holds or a cue finds", () => {
    expect(fit("**Deductions**", [["Deductions", "person"]])).toEqual([]);
    expect(fit("**Chief Complaint**", [["Complaint", "person"]])).toEqual([]);
    expect(fit("TOTAL DEDUCTIONS 4500", [["DEDUCTIONS", "person"]])).toEqual([]);
    expect(fit("Exciting News - Elevate Your Ads!", [["Elevate", "person"]])).toEqual([]);
    expect(fit("Meeting with King tomorrow", [["King", "person"]])).toEqual(["person:King"]);
    expect(fit("Ask Price about it", [["Price", "person"]])).toEqual(["person:Price"]);
    expect(fit("Fletcher was contacted", [["Fletcher", "person"]])).toEqual(["person:Fletcher"]);
    expect(fit("Bill said hi", [["Bill", "person"]])).toEqual(["person:Bill"]);
    expect(fit("Dear Complaint, hello", [["Complaint", "person"]], ["Complaint"])).toEqual(["person:Complaint"]);
    expect(fit("met Chief Complaint today", [["Chief Complaint", "person"]])).toEqual(["person:Chief Complaint"]);
    expect(fit("met Zorvan today", [["Zorvan", "person"]])).toEqual(["person:Zorvan"]);
  });
  it("is dropped with a digit or a symbol in it", () => {
    expect(fit("at 2023-10-05T14:48:00Z then", [["2023-10-05T14:48:00Z", "person"]])).toEqual([]);
  });
  it("is dropped when an organisation's word ends it or follows it written as part of it", () => {
    expect(fit("Debited from Example Mahindra Bank **4417", [["Example Mahindra", "person"]])).toEqual([]);
    expect(fit("work at Zorvan & Associates is", [["Zorvan", "person"]])).toEqual([]);
    expect(fit("Issuer: Bank of Zorvania, Routing", [["Zorvania", "person"]])).toEqual([]);
    expect(fit("Issuer: Bank of Zorvania, Routing", [["Bank of Zorvania", "person"]])).toEqual([]);
  });
  it("is dropped when a place's word ends it or follows it written as part of it (forms.ts's, the names way's own)", () => {
    expect(fit("near Zorvan Nagar today", [["Zorvan Nagar", "person"]])).toEqual([]);
    expect(fit("near Zorvan Nagar today", [["Zorvan", "person"]])).toEqual([]);
    expect(fit("Zorvan city mein hai", [["Zorvan", "person"]])).toEqual(["person:Zorvan"]);
  });
  it("is kept before `&` and a word written small: the sentence's (`& team`), as the names way reads it", () => {
    expect(fit("Priya & team are coming", [["Priya", "person"]])).toEqual(["person:Priya"]);
    expect(fit("Zorvan & Sons Pvt", [["Zorvan", "person"]])).toEqual([]);
  });
  it("is kept when a small noun from the organisation list follows it: the sentence's", () => {
    expect(fit("Zorva school se aa gayi", [["Zorva", "person"]])).toEqual(["person:Zorva"]);
    expect(fit("Ravi team ke saath hai", [["Ravi", "person"]])).toEqual(["person:Ravi"]);
  });
  it("shown with its handle is a name and an account", () => {
    expect(fit("Zorvan Example @zorvan__ · 2h", [["Zorvan Example @zorvan__", "person"]])).toEqual(["person:Zorvan Example", "account:@zorvan__"]);
  });
  it("is cut at its slashes, each piece checked", () => {
    expect(fit("TRF/ZORVAN EXAMPLE/238461550000 -₹3499.01", [["TRF/ZORVAN EXAMPLE", "person"]])).toEqual(["person:ZORVAN EXAMPLE"]);
  });
  it("keeps an initial's dot", () => {
    expect(fit("Call Zorvan S. today", [["Zorvan S.", "person"]])).toEqual(["person:Zorvan S."]);
  });
});

describe("a number", () => {
  it("is no date, time, amount, decimal, version or hash, read as written", () => {
    expect(fit("Flight 6E 4891, 25-02-2026, departs 6:17 PM", [["02", "number"], ["departs 6:17 PM", "number"]])).toEqual([]);
    expect(fit("Order total: ₹1,234.50 today", [["1,234.50", "number"]])).toEqual([]);
    expect(fit("txn of INR 2086.93 at a shop", [["INR 2086.93", "number"]])).toEqual([]);
    expect(fit("Rs.4291.70 debited", [["Rs.4291", "number"], [".70", "number"]])).toEqual([]);
    expect(fit("paid AED 12345 today", [["12345", "number"]])).toEqual([]);
    expect(fit("sent 4500 SGD today", [["4500", "number"]])).toEqual([]);
    expect(fit("pinned to v1.2.3 now", [["v1.2.3", "number"]])).toEqual([]);
    expect(fit("macOS 10.15.7 ships", [["10.15.7", "number"]])).toEqual([]);
    expect(fit("logged in 2019 again", [["2019", "number"]])).toEqual([]);
    expect(fit("commit 3f9a1c7e2b landed", [["3f9a1c7e2b", "number"]])).toEqual([]);
    expect(fit("for AY 2026-27, my", [["AY 2026-27", "number"]])).toEqual([]);
  });
  it("is no amount after a money word, nor a flight's, a train's or a bus's number", () => {
    expect(fit("Example Nagar, rent is 32000, his PAN", [["32000", "address"]])).toEqual([]);
    expect(fit("Total: 4500 only", [["4500", "number"]])).toEqual([]);
    expect(fit("Booking reference: QWERTZ\nFlight 6E 4891, BLR → DEL", [["Flight 6E 4891", "number"], ["BLR", "number"]])).toEqual([]);
    expect(fit("Train No./Name: 12951 / EXAMPLE EXPRESS", [["12951", "number"]])).toEqual([]);
    expect(fit("Order No. 12951 shipped", [["12951", "number"]])).toEqual(["number:12951"]);
  });
  it("is cut at its line breaks, and joins no amount or time beside it", () => {
    expect(fit("Booking reference: QWERTZ\nFlight 6E 1594, BLR", [["QWERTZ\nFlight 6E 1594, BLR", "number"]])).toEqual(["number:QWERTZ"]);
    expect(fit("UPI DR4417  -INR 2,345.00", [["DR4417", "number"], ["-INR 2", "number"]])).toEqual(["number:DR4417"]);
    expect(fit("Flight 6E 4891, 25-02-2026, departs 6:17 PM", [["02", "number"], ["2026", "number"], ["departs", "number"], ["6:", "number"]])).toEqual([]);
  });
  it("is kept when it reads as a date with no day or month in range, or a year after a number's label", () => {
    expect(fit("ref 12-34-56 and", [["12-34-56", "number"]])).toEqual(["number:12-34-56"]);
    expect(fit("case 4521-77 open", [["4521-77", "number"]])).toEqual(["number:4521-77"]);
    expect(fit("Employee ID 2019 joined", [["2019", "number"]])).toEqual(["number:2019"]);
  });
  it("is the id its letters run into, and a code of capitals and digits in words", () => {
    expect(fit("Medical Record Number: MRN-456723\nNext", [["MRN", "number"]])).toEqual(["number:MRN-456723"]);
    expect(fit("for example: B 1982 RUT\n4.", [["B 1982 RUT", "number"]])).toEqual(["number:B 1982 RUT"]);
  });
  it("is no machine's key in a page's code, but after a number's label", () => {
    expect(fit('<Icon name="x7k2m9"/>', [["x7k2m9", "number"]])).toEqual([]);
    expect(fit("an employee id c4b8f7d5, for example", [["c4b8f7d5", "number"]])).toEqual(["number:c4b8f7d5"]);
  });
  it("keeps its mask, but no bold's stars", () => {
    expect(fit("card **** **** **** 4417 due", [["**** 4417", "number"]])).toEqual(["number:**** **** **** 4417"]);
    expect(fit("call ******4417 now", [["******4417", "phone"]])).toEqual(["number:******4417"]);
    expect(fit("| **Total** | **30495** |", [["30495", "number"]])).toEqual(["number:30495"]);
    expect(fit("Debited from Example Bank **4417\n22-10-2026", [["4417", "number"]])).toEqual(["number:**4417"]);
    expect(fit("- **Phone Number:** 555-010-0123", [["555-010-0123", "phone"]])).toEqual(["phone:555-010-0123"]);
  });
  it("of two whole numbers a comma parts stays two", () => {
    expect(fit("Order 12345, 67890 shipped", [["12345", "number"], ["67890", "number"]])).toEqual(["number:12345", "number:67890"]);
  });
  it("is kept when it ends in a year's digits, or begins with a letter v", () => {
    expect(fit("card 4111 1111 1111 2016 was", [["4111 1111 1111 2016", "number"]])).toEqual(["number:4111 1111 1111 2016"]);
    expect(fit("plate V52-9481-331-48 or", [["V52-9481-331-48", "number"]])).toEqual(["number:V52-9481-331-48"]);
  });
  it("keeps its label inside it, and widens over the id it stands in", () => {
    expect(fit("the SSN 459-00-0000 was", [["SSN 459-00-0000", "number"]])).toEqual(["number:SSN 459-00-0000"]);
    expect(fit("ids BIO-7369860000 and", [["-7369860000", "number"]])).toEqual(["number:BIO-7369860000"]);
  });
  it("is dropped with fewer than three digits, but for a code of capitals", () => {
    expect(fit("M 46 CNF", [["46", "number"]])).toEqual([]);
    expect(fit("Swift BIC: ZXCPYP10XZ", [["ZXCPYP10XZ", "number"]])).toEqual(["number:ZXCPYP10XZ"]);
  });
  it("is kept as letters alone after its label, or masked", () => {
    expect(fit("Booking reference: QWERTZ\nFlight", [["QWERTZ", "number"]])).toEqual(["number:QWERTZ"]);
    expect(fit("Credit card XXXX XXXX XXXX 2019 due", [["XXXX XXXX XXXX 2019", "phone"]])).toEqual(["number:XXXX XXXX XXXX 2019"]);
  });
});

describe("an address", () => {
  it("is dropped as a lone word", () => {
    expect(fit("Favourites   Recents   Keypad", [["Keypad", "address"]])).toEqual([]);
    expect(fit("aaja yahi hai", [["yahi hai", "address"]])).toEqual([]);
  });
  it("as a passenger's name in capitals, typed a number, is a name where the names way found one", () => {
    expect(fit("Passengers:\n1. ZORVAN EXAMPLE M 51 CNF", [["EXAMPLE", "number"]], ["ZORVAN EXAMPLE"])).toEqual(["person:EXAMPLE"]);
    expect(fit("Passengers:\n1. ZORVAN EXAMPLE M 51 CNF", [["EXAMPLE", "number"]])).toEqual([]);
  });
  it("is no amount and no machine's key", () => {
    expect(fit("Received from Zorvan a sum of ₹32,000 towards rent", [["a sum of ₹32,000 towards rent", "address"]])).toEqual([]);
    expect(fit("build 3f9a1c7e done", [["3f9a1c7e", "address"]])).toEqual([]);
  });
  it("is kept with a number and words, a street word, or a town and its state", () => {
    expect(fit("I live at 12 Example Road now", [["12 Example Road", "address"]])).toEqual(["address:12 Example Road"]);
    expect(fit("Property: Via Zorvani Example, 65", [["Via Zorvani Example", "address"]])).toEqual(["address:Via Zorvani Example"]);
    expect(fit("Address: Zorvan Haven, Exampleshire, SSN", [["Zorvan Haven, Exampleshire", "address"]])).toEqual(["address:Zorvan Haven, Exampleshire"]);
  });
  it("is joined from its pieces on one line, a name's mark between them aside", () => {
    expect(fit("Sender: 894 Zorvan Example, Exampleton\nNext", [["894", "address"], ["Zorvan", "person"], ["Zorvan Example", "address"], ["Exampleton", "address"]]))
      .toEqual(["address:894 Zorvan Example, Exampleton", "person:Zorvan"]);
    expect(fit("Sender: 894 Zorvan Chowk, Exampleton\nNext", [["894", "address"], ["Zorvan", "person"], ["Zorvan Chowk", "address"], ["Exampleton", "address"]]))
      .toEqual(["address:894 Zorvan Chowk, Exampleton"]);
  });
  it("as a latitude and longitude is a place", () => {
    expect(fit("at coordinate 40.6700, -97.9300, was", [["40.6700, -97.9300", "address"]])).toEqual(["place:40.6700, -97.9300"]);
    expect(fit("around the coordinate 46.2247, 6.8414. The", [["46", "address"], ["2247,", "address"], ["6.8414", "address"]])).toEqual(["place:46.2247, 6.8414"]);
    expect(fit("- Location: Latitude: 31.2845, Longitude: 50.8246", [["31.2845", "address"]])).toEqual(["place:Latitude: 31.2845, Longitude: 50.8246"]);
  });
  it("as digits beside a code's cue is a secret", () => {
    expect(fit("provided the pin 1953 to verify", [["1953", "address"]])).toEqual(["secret:1953"]);
  });
});

describe("a secret", () => {
  it("is no plain word, piece of a link, or amount", () => {
    expect(fit("Key: abc used in the request", [["used", "secret"]])).toEqual([]);
    expect(fit("reset at https://example.com/x", [["https", "secret"], ["://example.com", "secret"]])).toEqual([]);
    expect(fit("UPI -₹3499.01 paid", [["₹3499", "secret"]])).toEqual([]);
  });
  it("is a plain word or three digits only right after its cue; else what it has the shape of", () => {
    expect(fit("- Password: sunshine\n", [["sunshine", "secret"]])).toEqual(["secret:sunshine"]);
    expect(fit("CVV: 123 on the back", [["123", "secret"]])).toEqual(["secret:123"]);
    expect(fit("room 123 on the left", [["123", "secret"]])).toEqual(["number:123"]);
  });
  it("is no link's host and path; a piece of a user and host's word is the whole word, an account", () => {
    expect(fit("Link: drive.example.com/d/ab12cd", [["drive.example.com/d/ab12cd", "secret"]])).toEqual([]);
    expect(fit("at https://example.com/x/ab12 now", [["example.com/x/ab12", "secret"]])).toEqual([]);
    expect(fit("zorvan@macbook-pro-0001:~$ cd /Users", [["@macbook", "secret"], ["-0001", "secret"]])).toEqual(["account:zorvan@macbook-pro-0001"]);
    expect(fit("DATABASE_URL=postgres://db.example.com:5432/app", [["db.example.com:5432", "secret"]])).toEqual([]);
  });
  it("is a link's user and password after its `://`: only its host is none", () => {
    const url = "DATABASE_URL=postgres://admin:Zx7Pw2qVnT@db.example.com/app";
    expect(fit(url, [["admin:Zx7Pw2qVnT@db.example.com", "secret"]])).toEqual(["secret:admin:Zx7Pw2qVnT@db.example.com"]);
    expect(fit(url, [["admin:Zx7Pw2qVnT", "secret"]])).toContainEqual("secret:admin:");
  });
  it("of words a space parts stands after its cue; else each word is checked alone", () => {
    expect(fit("Authorization: token Zx7P2qVnTmZxL4jS9vFb", [["token Zx7P2qVnTmZxL4jS9vFb", "secret"]])).toEqual(["secret:token Zx7P2qVnTmZxL4jS9vFb"]);
    expect(fit("gpay kar de zorvan@okbank pe", [["kar de", "secret"]])).toEqual([]);
    expect(fit("zorvan@macbook-pro-0001:~$ cd /Users", [["zorvan@macbook-pro-0001:~$ cd /Users", "secret"]])).toEqual(["secret:zorvan@macbook-pro-0001:~$"]);
    expect(fit("passphrase: correct horse battery", [["correct horse battery", "secret"]])).toEqual(["secret:correct horse battery"]);
  });
  it("as digits after a key that names no secret is none", () => {
    expect(fit("DB_PASSWORD=Zorvan@4521\nPORT=3000", [["3000", "secret"]])).not.toContainEqual("secret:3000");
    expect(fit("PIN=4521 ok", [["4521", "secret"]])).toEqual(["secret:4521"]);
  });
  it("may hold an @", () => {
    expect(fit("DB_PASSWORD=Zorvan@4521\nPORT", [["Zorvan@4521", "secret"]])).toEqual(["secret:Zorvan@4521"]);
  });
  it("is kept with digits in it, and as a year's digits beside its cue", () => {
    expect(fit("- **Password:** Zorvan1995", [["Zorvan1995", "secret"]])).toEqual(["secret:Zorvan1995"]);
    expect(fit("otp aaya 2019 bata de", [["2019", "secret"]])).toEqual(["secret:2019"]);
    expect(fit("logged 2019 at noon", [["2019", "secret"]])).toEqual([]);
    expect(fit("naya 2019 mpin hai", [["2019", "secret"]])).toEqual(["secret:2019"]);
  });
});

describe("an email and a phone", () => {
  it("an email holds an @", () => {
    expect(fit("gpay kar de 7000000000@ybl pe", [["pe", "email"]])).toEqual([]);
    expect(fit("mail person-a@example.com now", [["person-a@example.com", "email"]])).toEqual(["email:person-a@example.com"]);
  });
  it("an email from a sender's mailbox that takes no mail is none; a desk's and a person's are kept", () => {
    expect(fit("From: Example Bank <alerts@bank.example.com>", [["alerts@bank.example.com", "email"]])).toEqual([]);
    expect(fit("From: Example <no-reply@example.com>", [["no-reply@example.com", "email"]])).toEqual([]);
    expect(fit("From: Carey Example <carey@example.com>", [["carey@example.com", "email"]])).toEqual(["email:carey@example.com"]);
    expect(fit("contact our team at support@example.com", [["support@example.com", "email"]])).toEqual(["email:support@example.com"]);
  });
  it("a phone in pieces is one; two phones a comma parts stay two", () => {
    expect(fit("call 555-010-0123 or", [["555-010", "phone"], ["0123", "phone"]])).toEqual(["phone:555-010-0123"]);
    expect(fit("Phone: +15550000001, +15550000002 ok", [["+15550000001", "phone"], ["+15550000002", "phone"]])).toEqual(["phone:15550000001", "phone:15550000002"]);
    expect(fit("Tel 5550101, 5550102 ok", [["5550101", "phone"], ["5550102", "phone"]])).toEqual(["phone:5550101", "phone:5550102"]);
  });
  it("a dotted phone is no version", () => {
    expect(fit("fax 555.010.0123 now", [["555.010.0123", "phone"]])).toEqual(["phone:555.010.0123"]);
    expect(fit("Phone: 07.5550.0123\n", [["07.5550.0123", "phone"]])).toEqual(["phone:07.5550.0123"]);
  });
  it("a handle parted at its @ is the whole handle; one word the mark runs on to is left", () => {
    expect(fit("gpay kar de zorva.example@okbank pe", [["zorva.example@", "email"], ["okbank pe", "person"]])).toEqual(["account:zorva.example@okbank"]);
    expect(fit("from zorva.ex@okbank (ZORVA EX) on", [["zorva.ex@", "email"], ["okbank (ZORVA EX)", "person"]])).toEqual(["account:zorva.ex@okbank", "person:ZORVA EX"]);
    expect(fit("mail zorva_ex@example.com now", [["zorva_ex", "email"], ["@example.com", "person"]])).toEqual(["email:zorva_ex@example.com"]);
  });
  it("pieces are never joined across a line", () => {
    expect(fit("+15550000001\nOffice 011-5550 0123", [["+15550000001", "phone"], ["Office", "phone"], ["011-5550 0123", "phone"]])).toEqual(["phone:15550000001", "phone:011-5550 0123"]);
  });
});

describe("another type's shape", () => {
  it("a user name typed a person is an account", () => {
    expect(fit("**User ID:** zorvan_example12", [["zorvan_example12", "person"]])).toEqual(["account:zorvan_example12"]);
    expect(fit("follow @zorvanexample on insta", [["@zorvanexample", "person"]])).toEqual(["account:@zorvanexample"]);
    expect(fit("follow @zorvan_ now", [["@zorvan_", "person"]])).toEqual(["account:@zorvan_"]);
    expect(fit("User: zorvanex\nBye", [["zorvanex", "address"]])).toEqual(["account:zorvanex"]);
  });
  it("a thing's name with a version is no account", () => {
    expect(fit("the model zorvan_large_4.5 said", [["zorvan_large_4.5", "person"]])).toEqual([]);
  });
  it("a name People holds or a cue finds, typed an address, is a person", () => {
    expect(fit("Nominee\nRose Example\nContinue", [["Rose Example", "address"]], ["Rose Example"])).toEqual(["person:Rose Example"]);
    expect(fit("Nominee\nRose Example\nContinue", [["Rose Example", "address"]])).toEqual([]);
  });
  it("a link is kept as found", () => {
    expect(fit("see example.com/a", [["example.com/a", "link"]])).toEqual(["link:example.com/a"]);
  });
});
