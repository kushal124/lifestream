import Database from "better-sqlite3";

export function chatStore(path: string, messages: number, body = "hex(randomblob(40))"): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT);
    CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, ZCHATSESSION INTEGER, ZPARENTMESSAGE INTEGER,
                             ZFROMJID TEXT, ZTEXT TEXT, ZMESSAGEDATE REAL, ZSORT INTEGER);
    INSERT INTO ZWACHATSESSION VALUES (1, '15550000001@s.whatsapp.net', 'Person A'),
                                      (2, '15550000002@s.whatsapp.net', 'Person B');
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${messages})
    INSERT INTO ZWAMESSAGE SELECT x, 1 + x % 2, CASE WHEN x % 10 = 0 THEN x - 5 END,
      '1555000000' || (1 + x % 2) || '@s.whatsapp.net', ${body}, 781_000_000.5 + x, x FROM n;
  `);
  db.close();
}
