import { describe, expect, it } from "vitest";
import { generate } from "./bench/synthetic.js";
import { mergeMarks } from "./merge.js";
import { allRules, labelCues, ruleMarks } from "./rules.js";
const RULES = allRules();

const EXAMPLES: Record<string, { text: string; marks: string[] }> = {
  "network id": { text: "chat 15550000001@s.whatsapp.net and ada.example@lid muted", marks: ["phone 15550000001@s.whatsapp.net", "account ada.example@lid"] },
  "email": { text: "Write to person-a@example.com today.", marks: ["email person-a@example.com"] },
  "card number after its label": { text: "**Credit/Debit Card Number:** 4532 7894 5612 3478, your card ending in 4921 7856 3490 1287", marks: ["number.card 4532 7894 5612 3478", "number.card 4921 7856 3490 1287"] },
  "id after its label": { text: "Medical Record Number: 1985-47-8256, customer id 23CLNT21347, Employee ID | MKT-4729 |, License Plate: 578 HXR; Medical Record Numbers: MED29400772, G5644350; Employee IDs Yl-56633 and Xj-97738", marks: ["number 1985-47-8256", "number 23CLNT21347", "number MKT-4729", "number 578 HXR", "number MED29400772", "number G5644350", "number Yl-56633", "number Xj-97738"] },
  "id after a person's word": { text: "Employee B-806498-Y initiated it for patient F9564183 and customer 12345678; Part Number: K-52661-V", marks: ["number B-806498-Y", "number F9564183", "number 12345678", "number K-52661-V"] },
  "government id after its label": { text: "Passport No: Z1234567, mera voter id ABC1234567 hai, DL No. KA01 20190001234, SSN ZZ 07 17 46 T", marks: ["number.government Z1234567", "number.government ABC1234567", "number.government KA01 20190001234", "number.government ZZ 07 17 46 T"] },
  "tax id after its label": { text: "- Tax ID: 925-85-6734", marks: ["number.tax 925-85-6734"] },
  "bank number after its label": { text: "Bank Routing Number: 231017465, SWIFT BIC of ZXFYINBK109, Beneficiary: 001255501234, Account Number: ACCT-846703889", marks: ["number.bank 231017465", "number.bank ZXFYINBK109", "number.bank 001255501234", "number.bank ACCT-846703889"] },
  "order number after its label": { text: "Order #405-1234567-1234567 has shipped; IRCTC E-Ticket\nPNR No.: 8050570637", marks: ["number.order 405-1234567-1234567", "number.order 8050570637"] },
  "record locator after its label": { text: "Booking reference QXTRWP for your flight", marks: ["number.order QXTRWP"] },
  "user name after its label": { text: "**User ID:** saeed_example12, username, such as ada2023, and the user ada.example", marks: ["account saeed_example12", "account ada2023", "account ada.example"] },
  "address after its label": { text: "Address: H.No. 4-5-678, Road No. 3, Example Nagar, Hyderabad - 500001\nEmail Address: person-a@example.com\nDelivered to: 167, Example Dham, Aundh\nConsignee: 58/523 Example Zila, Apt. 974.", marks: ["address H.No. 4-5-678, Road No. 3, Example Nagar, Hyderabad - 500001", "address 167, Example Dham, Aundh", "address 58/523 Example Zila, Apt. 974"] },
  "address after its words": { text: "She resides at 2140 Example Centers. The premises at Example Prospekt, 38 are shut; my flat is B-204, Example Apartments", marks: ["address 2140 Example Centers", "address Example Prospekt, 38", "address B-204, Example Apartments"] },
  "phone after its word": { text: "Not you? Call 18005550100 now, or WhatsApp number 5550000123", marks: ["phone 18005550100", "phone 5550000123"] },
  "phone, international": { text: "Mobile: +91 55500 00001, office 0044 20 7946 0000, desk +1-555-000-0001x6515, home (+91) 55500 00002", marks: ["phone +91 55500 00001", "phone 0044 20 7946 0000", "phone +1-555-000-0001x6515", "phone (+91) 55500 00002"] },
  "phone, North America": { text: "Call (555) 000-0002 or 555.000.0003, toll free 1-800-555-0100, phone number (555-000-0004)", marks: ["phone (555) 000-0002", "phone 555.000.0003", "phone 1-800-555-0100", "phone 555-000-0004"] },
  "phone, India": { text: "mera number 98765 00123 hai, ya 9876500124", marks: ["phone 98765 00123", "phone 9876500124"] },
  "phone, national": { text: "Office: 080-4710 0123, fax (020)7946 0000 or 0113 496 0204", marks: ["phone 080-4710 0123", "phone (020)7946 0000", "phone 0113 496 0204"] },
  "card": { text: "card no 4111 1111 1111 1111 exp 09/29", marks: ["number.card 4111 1111 1111 1111"] },
  "IBAN": { text: "IBAN GB82 WEST 1234 5698 7654 32 for the transfer", marks: ["number.bank GB82 WEST 1234 5698 7654 32"] },
  "IFSC": { text: "IFSC: HDFC0001234", marks: ["number.bank HDFC0001234"] },
  "id by its prefix": { text: "assigned to EMP902850 and MRN-567234", marks: ["number EMP902850", "number MRN-567234"] },
  "id of a capital and digits": { text: "moved from Location M-222475-P to Z1587967 for Sz-1601234", marks: ["number M-222475-P", "number Z1587967", "number Sz-1601234"] },
  "postal item": { text: "sent by India Post (EE123456785IN), tracking RR987654321GB", marks: ["number.order EE123456785IN", "number.order RR987654321GB"] },
  "SWIFT code": { text: "wire to XFMLUS4T791 by Friday", marks: ["number.bank XFMLUS4T791"] },
  "routing number": { text: "ACH via 021000021 today", marks: ["number.bank 021000021"] },
  "last digits": { text: "spent on your card ending 4821 at a shop; Rs.500 from Example Bank A/c 1234, spent on Example Bank Card 5678", marks: ["number 4821", "number 1234", "number 5678"] },
  "masked phone": { text: "OTP sent to your mobile 98XXXX1234 and +9155*****678", marks: ["phone 98XXXX1234", "phone +9155*****678"] },
  "masked digits": { text: "debited from A/c XX1234 and **5678, A/c *9012, card **** **** **** 3456 or XXXX-XXXX-XXXX-7890", marks: ["number XX1234", "number **5678", "number *9012", "number **** **** **** 3456", "number XXXX-XXXX-XXXX-7890"] },
  "GSTIN": { text: "GSTIN 29ABCCE1234F1Z5", marks: ["number.tax 29ABCCE1234F1Z5"] },
  "PAN": { text: "PAN: ABCPE1234F", marks: ["number.tax ABCPE1234F"] },
  "Aadhaar": { text: "Aadhaar: 2345 6789 0124", marks: ["number.government 2345 6789 0124"] },
  "SSN": { text: "SSN 123-45-6789 on file", marks: ["number.government 123-45-6789"] },
  "payment address": { text: "gpay kar de ada.example@okaxis pe", marks: ["number.payment ada.example@okaxis"] },
  "wallet address": { text: "send to 0x52908400098527886E0F7030069857D2E4169EE7", marks: ["number.payment 0x52908400098527886E0F7030069857D2E4169EE7"] },
  "key by its prefix": { text: "OPENAI_API_KEY=sk-proj-EXAMPLEabcdefghij0123456789", marks: ["secret sk-proj-EXAMPLEabcdefghij0123456789"] },
  "private key": { text: "-----BEGIN RSA PRIVATE KEY-----\nMIIEexample\n-----END RSA PRIVATE KEY-----", marks: ["secret -----BEGIN RSA PRIVATE KEY-----\nMIIEexample\n-----END RSA PRIVATE KEY-----"] },
  "web token": { text: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJlLWV4YW1wbGU", marks: ["secret eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJleGFtcGxlIn0.c2lnbmF0dXJlLWV4YW1wbGU"] },
  "value after its word": { text: "password: hunter2! and **Password:** Example1995, Password: *******", marks: ["secret hunter2!", "secret Example1995", "secret *******"] },
  "secret in a sentence": { text: "wifi ka password home1234! hai; the API key K9wPm7sB2vT6ZcR1xLmQ is new; the password for the plan database is River99!", marks: ["secret home1234!", "secret K9wPm7sB2vT6ZcR1xLmQ", "secret River99!"] },
  "code after its word": { text: "Use OTP: 482913 to log in; bhai otp aaya 551234 bata de; backup codes: 4821 9930; your MPIN is 4821#; the pin for Ada's health records is 425917; One Time Password (OTP) is 774400", marks: ["secret 482913", "secret 551234", "secret 4821 9930", "secret 4821#", "secret 425917", "secret 774400"] },
  "codes listed after their word": { text: "Your backup codes: 4821 9930 5512 0471 7730 2296\nRecovery codes:\n1. 1111 2222\n2. 3333 4444", marks: ["secret 4821 9930", "secret 5512 0471", "secret 7730 2296", "secret 1111 2222", "secret 3333 4444"] },
  "codes by their shape": { text: "Keep these safe:\n1234 5678\n2345 6789\n3456 7890\nthe years 2021 2022 2023 2024 2025 2026 are no codes", marks: ["secret 1234 5678", "secret 2345 6789", "secret 3456 7890"] },
  "card code after its word": { text: "the CVV is 674, and | CVV | 354 |", marks: ["secret 674", "secret 354"] },
  "code before its word": { text: "774411 is your OTP for login", marks: ["secret 774411"] },
  "key by its letters": { text: "include api_dev_9LkJhW5Rz3PqXtB1MvFyNxmS8zZ7K9K in the header.", marks: ["secret api_dev_9LkJhW5Rz3PqXtB1MvFyNxmS8zZ7K9K"] },
  "password after a login": { text: "Login: person-a@example.com / Xq9!kz-7Lp, the portal ada.example / k7-river-stone-2", marks: ["secret Xq9!kz-7Lp", "secret k7-river-stone-2"] },
  "password by its shape": { text: "my login is Example@123 now", marks: ["secret Example@123"] },
  "street address": { text: "aaja B-350, Example Apartments, Near Metro Station pe; she lives at 116 Example Road SE, Springfield, VA 23832. Sent from 2140 Example Centers; aaja 167, Example Dham, Aundh pe; Plot 14, Sector62, Noida", marks: ["address B-350, Example Apartments, Near Metro Station", "address 116 Example Road SE, Springfield, VA 23832", "address 2140 Example Centers", "address 167, Example Dham, Aundh", "address Plot 14, Sector62, Noida"] },
  "coordinate pair": { text: "pinned at 12.97160, 77.59460, then Latitude: 53.5082, Longitude: -6.5082", marks: ["place 12.97160, 77.59460", "place Latitude: 53.5082, Longitude: -6.5082"] },
  "home folder": { text: "open /Users/adaex/Documents/tax", marks: ["account adaex"] },
  "shell prompt": { text: "ada@macbook-pro-0001:~$ ls", marks: ["account ada"] },
  "handle": { text: "follow @ada.example_12 on insta", marks: ["account @ada.example_12"] },
  "user name by its shape": { text: "| 1.0.2 | adaex92 | fix | assigned to tw_exa198, then AdaExample93 and Exampleton2001.", marks: ["account adaex92", "account tw_exa198", "account AdaExample93", "account Exampleton2001"] },
  "profile path": { text: "see linkedin.com/in/ada-example-123 and github.com/adaex42", marks: ["account ada-example-123", "account adaex42"] },
};

const found = (text: string) => ruleMarks(text, "tokens").marks.map((mark) => `${mark.type} ${text.slice(mark.start, mark.end)}`);
const merged = (text: string) => mergeMarks(ruleMarks(text, "tokens").marks.map((mark) => ({ ...mark, way: 4 })), "all").map((mark) => `${mark.type} ${text.slice(mark.start, mark.end)}`);

describe("each rule", () => {
  for (const rule of RULES) {
    const example = EXAMPLES[rule.name];
    if (example === undefined) continue;
    it(`${rule.name}: marks its own shape as ${rule.type === "id" ? "its id's type" : rule.type}`, () => {
      const marks = found(example.text);
      for (const mark of example.marks) expect(marks).toContain(mark);
    });
  }

  it("masked digits: no markdown bold before a year", () => {
    expect(found("**Date of Birth:** 2019-06-12 and **Tax Year:** 2022, **2024 Model X**, on **2023-10-15**")).toEqual([]);
  });

  it("a value after its label is no value when it is a date, a year or a plain word, and the label after it is still read", () => {
    expect(found("Policy Date: 2024-03-15, Employee ID: pending, Customer ID 2023, Part Number 12345, employees 2,500, Token: 42")).toEqual([]);
    expect(found("IRCTC E-Ticket\nPNR No.: 4512367890")).toEqual(["number.order 4512367890"]);
  });

  it("an address's label after an email's, a network's or a wallet's word is no address, nor a label's word alone", () => {
    expect(merged("Email Address: person-a@example.com\nIP Address: 192.0.2.10\nWallet address: none\n**Policyholder Address:**\n- **Street Address:** 222 Example Ave")).toEqual(["email person-a@example.com", "address 222 Example Ave"]);
  });

  it("a label joined to the word after it is no label, nor a folder named home inside a path, nor a card's last digits a year's markdown", () => {
    expect(found("a password-protected file, an address-book entry, apps/home/notes and src/Users/list, **Tax Year:** 2022")).toEqual([]);
  });

  it("a short address is no item's number nor a form's next label", () => {
    expect(found("Hazardous Material: Class 3, Packing Group II, Quantity: 500kg; In 2023, Google, Microsoft and Apple")).toEqual([]);
  });

  it("an email from a sender's mailbox that takes no mail is no person's; a desk's, and a person's own address at a company's domain, are", () => {
    expect(found("From: Example Bank <alerts@bank.example.com>, noreply@example.com, do-not-reply@example.in, notifications.in@example.com, statements123@example.com")).toEqual([]);
    expect(found("From: carey@example.com, alertsby.person@example.com, write to support@example.com, ada.example@company.example.com")).toEqual(["email carey@example.com", "email alertsby.person@example.com", "email support@example.com", "email ada.example@company.example.com"]);
    expect(found("From: notifications+ada_example@example.com, alerts.ada.example@bank.example.com")).toEqual(["email notifications+ada_example@example.com", "email alerts.ada.example@bank.example.com"]);
  });

  it("an id after its label that counts from one in a series is the person's still, and an id by its shape in a column a product's code heads is the product's", () => {
    expect(merged("Employee ID: EMP-042\nRoll No: CS-042\nPatient ID: PT-007\nMember ID: MEM-015\nClaim No: CLM-2024-001\nCase No: CRL-2024-015")).toEqual(["number EMP-042", "number CS-042", "number PT-007", "number MEM-015", "number CLM-2024-001", "number CRL-2024-015"]);
    const table = "| SKU | Qty | Holder |\n|---|---|---|\n| M123456 | 5 | Z1587967 |\n| AB-123456 | 3 | EMP902850 |";
    expect(merged(table)).toEqual(["number Z1587967", "number EMP902850"]);
    expect(merged("| Item | Patient |\n|---|---|\n| M123456 | F9564183 |")).toEqual(["number M123456", "number F9564183"]);
  });

  it("a payment address ends at its handle: a handle a domain goes on from is an email's, and the email row alone reads it", () => {
    expect(found("From: Example Bank <alerts@hdfcbank.example.com>, Pay ada.example@okaxis.")).toEqual(["number.payment ada.example@okaxis"]);
    expect(found("mail ada.example@sbi.example.com or ada@ybl-example.in; pay ada@ybl, x@okaxis.com")).toEqual(["email ada.example@sbi.example.com", "email ada@ybl-example.in", "email x@okaxis.com", "number.payment ada@ybl"]);
    expect(found("UPI-ADA EXAMPLE-ada.example@okaxis-SBIN0001234-312345678901-PAYMENT and ada@ybl-thanks")).toEqual(["number.bank SBIN0001234", "number.payment EXAMPLE-ada.example@okaxis", "number.payment ada@ybl"]);
  });

  it("an id after a respondent's, an applicant's, an account holder's or an inspector's label", () => {
    expect(merged("Respondent ID: RSP-48213, Applicant No. 5524183, Account Holder ID: 7781234, inspector F9564183")).toEqual(["number RSP-48213", "number 5524183", "number 7781234", "number F9564183"]);
  });

  it("a reference after its word alone, as after ref no: a bank's summary line, ref:, ref., Ref No., UPI ref, UTR and reference; the amount beside it no reference", () => {
    expect(found("UPI debit of Rs.16.00 to merchant-a (Example Bank; ref 123456789012)")).toEqual(["number.order 123456789012"]);
    expect(found("transaction, account credit: Example Bank; Rs.1.00; ref 625800000012")).toEqual(["number.order 625800000012"]);
    for (const label of ["ref:", "ref.", "Ref No.", "Ref# ", "UPI ref", "UPI Ref No:", "UTR", "UTR:", "reference", "Reference:", "Txn Ref:"]) {
      const text = `paid Rs.16.00, ${label} 123456789012`;
      expect({ text, marks: found(text) }).toEqual({ text, marks: ["number.order 123456789012"] });
    }
    expect(found("please refer 123456789012, refs: see 12, reference date 2024-03-15")).toEqual([]);
  });

  it("a list after a label goes on only with values of the first one's form", () => {
    expect(found("Account Number: 12345678, 500 for fees")).toEqual(["number.bank 12345678"]);
  });

  it("a password's or a key's word before plain words, an identifier or a postal PIN is no secret", () => {
    expect(found("reset your password: [Reset Password](x), the password manager, \"passwordHash\":\"hashed_password\",\"registrationDate\", PIN code 560001, pincode: 560002, zip code 94105")).toEqual([]);
  });

  it("a number beginning 00 written solid is no international phone, and an id after a label is the label's, not a phone", () => {
    expect(merged("ref 001255501234 and Account Number: 872-513-9462, IRCTC PNR: 8050570637")).toEqual(["number.order 001255501234", "number.bank 872-513-9462", "number.order 8050570637"]);
  });

  it("an id after its label: a payslip's UAN and PF number, a VIN of one digit, an id after an aside in brackets, never the next label's word", () => {
    expect(found("PAN: ABCDE1234F UAN: 100200300400 PF No: MH/BAN/0012345/000/0001234 Chassis No: MA1ABCDEFGHJKLMNP, Stripe subscription ID sub_1aBc2DefG3hijK, Passport (new one): Z1234567")).toEqual(
      ["number 100200300400", "number MH/BAN/0012345/000/0001234", "number MA1ABCDEFGHJKLMNP", "number sub_1aBc2DefG3hijK", "number.government Z1234567", "number.tax ABCDE1234F", "number Z1234567"],
    );
  });

  it("an address written a part a line after its label, or by its shape, ends where a label's line begins", () => {
    expect(merged("Billing address:\n#301,\nExample Nagar,\nSample Colony,\nPune-411001")).toEqual(["address #301,\nExample Nagar,\nSample Colony,\nPune-411001"]);
    expect(merged("Ship here 🏠 #301,\nExample Nagar,\nSample Colony,\nPune-411001 thanks")).toEqual(["address #301,\nExample Nagar,\nSample Colony,\nPune-411001"]);
    expect(merged("Flat 402, Example Road, J. P. Nagar, 100 Feet Road, Bengaluru 560078")).toEqual(["address Flat 402, Example Road, J. P. Nagar, 100 Feet Road, Bengaluru 560078"]);
    expect(merged("12 Example Rd,\nPhone: 5550100")).toEqual(["address 12 Example Rd"]);
  });

  it("a code after its word: a dial-in PIN of nine digits and its hash, a PIN that reads as a year", () => {
    expect(found("Dial in: +1 555-000-0001 PIN: 123456789# then; the pin 1953 for the door")).toContain("secret 123456789#");
    expect(found("the pin 1953 for the door")).toEqual(["secret 1953"]);
  });

  it("years in a row are no codes, a sum of money is no id, a product's name and a version no user name, a machine's terminal no user name", () => {
    expect(found("the years 2021 2022 2023 2024 2025 2026 in a row")).toEqual([]);
    expect(found("paid INR12345.99 and USD250 to Member Rs.15000 refund, upgrade to Windows10 or Office365, last login on ttys002, a 1:1 call, h264 video")).toEqual([]);
  });

  it("a key's letters inside a link are the link's", () => {
    expect(found("https://example.com/share/K9wPm7sB2vT6ZcR1xLmQyN4F").filter((mark) => !mark.startsWith("link"))).toEqual([]);
  });

  it("find the same read at their cues and lines as read over the whole text", () => {
    const glued = ["Plot 14, Sector62, Noida", "4th Cross, Koramangala560034", "Ship here #301,\nExample Nagar,\nSample Colony,\nPune-411001", "codes:\n1. 1111 2222\n2. 3333 4444", "ada@x Customer ID: 2023 Employee ID: X1234 a@b@example.com"];
    const texts = [...Object.values(EXAMPLES).map((example) => example.text), ...glued, ...generate(20261112, 1500).docs.map((doc) => doc.text)];
    const sorted = (text: string, everywhere: boolean) => ruleMarks(text, "tokens", everywhere).marks.map((mark) => `${mark.start} ${mark.end} ${mark.type}`).sort();
    for (const text of texts) expect({ text, marks: sorted(text, false) }).toEqual({ text, marks: sorted(text, true) });
  });

  it("a row's line pattern matches no line break and nothing empty, so the scan for a line's match goes on from the line's end", () => {
    const crossing = /\\s|\\n|\\S|\\D|\\W|\\P|\[\^|\\r/u;
    const property = (source: string) => [...source.matchAll(/\\p\{([^}]*)\}/gu)].some((match) => new RegExp(`\\p{${match[1]}}`, "u").test("\n"));
    const texts = ["", "\n", "\n\n", ...Object.values(EXAMPLES).map((example) => example.text), ...generate(20261113, 200).docs.map((doc) => doc.text)];
    const empty = (holds: RegExp) => new RegExp(`^(?:${holds.source})$`, holds.flags.replace(/[gy]/gu, "")).test("") || texts.some((text) => [...text.matchAll(new RegExp(holds.source, `${holds.flags.replace(/[gy]/gu, "")}g`))].some((match) => match[0] === ""));
    const dot = (source: string) => /(?<!\\)\./u.test(source.replace(/\[(?:\\.|[^\]\\])*\]/gu, ""));
    const lines = RULES.filter((rule) => rule.lineHolds !== undefined);
    expect(lines.length).toBeGreaterThan(0);
    for (const rule of lines) {
      const { source, flags } = rule.lineHolds!;
      expect({ rule: rule.name, crosses: crossing.test(source) || dot(source) || property(source) || /[sm]/u.test(flags), empty: empty(rule.lineHolds!) }).toEqual({ rule: rule.name, crosses: false, empty: false });
    }
  });

  it("a label's cues are read from the label: each alternative of a group it begins with, what follows a group it may leave out, never an optional letter", () => {
    expect(labelCues(["(?:(?:street|home) )?address", "deliver(?:y|ed)? to", "aadhaa?r", "a\\/c", "(?:resides?|residing) at"])).toEqual(["street", "home", "address", "deliver", "aadha", "a", "reside", "residing"]);
    expect(() => labelCues(["\\d+ no"])).toThrow();
  });

  it("each row has an example here", () => {
    expect(RULES.map((rule) => rule.name).filter((name) => EXAMPLES[name] === undefined)).toEqual([]);
  });
});
