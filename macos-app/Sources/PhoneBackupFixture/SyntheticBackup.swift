import CommonCrypto
import CryptoKit
import Foundation
import PhoneBackup
import Security
import SQLite3

public enum SyntheticBackup {
    public struct File {
        public let domain: String
        public let path: String
        public let content: Data
        public var protectionClass: UInt32
        public var record: Data?
        public var stale: Int64

        public init(domain: String, path: String, content: Data, protectionClass: UInt32 = 4, record: Data? = nil, stale: Int64 = 0) {
            self.domain = domain
            self.path = path
            self.content = content
            self.protectionClass = protectionClass
            self.record = record
            self.stale = stale
        }
    }

    public struct Made {
        public let url: URL
        public let udid: String
        public let serial: String
        public let lastBackup: Date
    }

    public struct Failed: Error, CustomStringConvertible {
        public let description: String
    }

    public static let password = "correct horse"
    public static let udid = "00008150-00117D2422D2401C"
    public static let serial = "FIXTURESERIAL01"
    public static let deviceName = "Test iPhone"

    public static let stores: [File] = [
        File(domain: BackupStore.messages.domain, path: BackupStore.messages.path, content: bytes(70_000, seed: 1)),
        File(domain: BackupStore.whatsAppChats.domain, path: BackupStore.whatsAppChats.path, content: bytes(123_457, seed: 2), protectionClass: 3),
        File(domain: BackupStore.whatsAppCalls.domain, path: BackupStore.whatsAppCalls.path, content: bytes(4_096, seed: 3), protectionClass: 3),
        File(domain: BackupStore.calls.domain, path: BackupStore.calls.path, content: bytes(16, seed: 4), protectionClass: 1),
        File(domain: BackupStore.messageAttachments.domain, path: BackupStore.messageAttachments.prefix + "ab/01/IMG_0001.HEIC", content: bytes(31, seed: 5), protectionClass: 2),
    ]

    public static func bytes(_ count: Int, seed: UInt8) -> Data {
        var data = Data(count: count)
        for index in 0..<count { data[index] = UInt8(truncatingIfNeeded: index &* 31 &+ Int(seed)) }
        return data
    }

    public static func write(in root: URL, password: String?, files: [File], udid: String = udid, serial: String = serial, deviceName: String = deviceName, finished: Bool = true,
                             lastBackup: Date = Date(timeIntervalSince1970: 1_787_916_055)) throws -> Made {
        let url = root.appendingPathComponent(udid)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        var manifestPlist: [String: Any] = [
            "Version": "10.0", "IsEncrypted": password != nil, "Date": lastBackup, "WasPasscodeSet": true,
            "Lockdown": ["ProductType": "iPhone18,1", "ProductVersion": "27.0", "BuildVersion": "24A5355q", "UniqueDeviceID": udid, "DeviceName": "a phone", "SerialNumber": serial],
            "Applications": ["net.whatsapp.WhatsApp": ["CFBundleIdentifier": "net.whatsapp.WhatsApp"], "com.apple.MobileSMS": [:]],
        ]
        var classKeys: [UInt32: Data] = [:]
        if let password {
            for number: UInt32 in [1, 2, 3, 4] { classKeys[number] = random(32) }
            manifestPlist["BackupKeyBag"] = try keybag(password: password, classKeys: classKeys)
            let manifestKey = random(32)
            manifestPlist["ManifestKey"] = classed(4, wrapped: try wrap(manifestKey, with: classKeys[4]!))
            let plainDb = try fileList(files: files, classKeys: classKeys, encrypted: true, at: url)
            try encrypt(plainDb, key: manifestKey).write(to: url.appendingPathComponent("Manifest.db"))
        } else {
            let plainDb = try fileList(files: files, classKeys: [:], encrypted: false, at: url)
            try plainDb.write(to: url.appendingPathComponent("Manifest.db"))
        }
        try PropertyListSerialization.data(fromPropertyList: manifestPlist, format: .binary, options: 0).write(to: url.appendingPathComponent("Manifest.plist"))
        try writeInfo(at: url, udid: udid, serial: serial, deviceName: deviceName, lastBackup: lastBackup)
        try writeStatus(at: url, finished: finished)
        return Made(url: url, udid: udid, serial: serial, lastBackup: lastBackup)
    }

    public static func writeInfo(at url: URL, udid: String, serial: String, deviceName: String = deviceName, lastBackup: Date) throws {
        var info: [String: Any] = ["Last Backup Date": lastBackup, "Product Type": "iPhone18,1", "Unique Identifier": udid]
        if !deviceName.isEmpty { info["Device Name"] = deviceName }
        if !serial.isEmpty { info["Serial Number"] = serial }
        try PropertyListSerialization.data(fromPropertyList: info, format: .binary, options: 0).write(to: url.appendingPathComponent("Info.plist"))
    }

    public static func writeStatus(at url: URL, finished: Bool) throws {
        try PropertyListSerialization.data(fromPropertyList: ["SnapshotState": finished ? "finished" : "new", "IsFullBackup": false, "Version": "3.3"] as [String: Any],
                                           format: .binary, options: 0)
            .write(to: url.appendingPathComponent("Status.plist"))
    }


    public static let appleID = "person-a@example.com"
    public static let ownJID = "15550000001@s.whatsapp.net"
    public static let friendJID = "15550000002@s.whatsapp.net"

    public static func phone(whatsAppMedia: [Int] = [2_000, 31, 70_001], calls: Bool = true,
                             appleID: String = appleID, ownJID: String = ownJID) throws -> [File] {
        var files: [File] = []
        let attachment = "Library/SMS/Attachments/ab/01/00000000-0000-0000-0000-00000000A001/IMG_0001.HEIC"
        files.append(File(domain: BackupStore.messages.domain, path: BackupStore.messages.path, content: try database(messagesSQL(attachment: attachment, appleID: appleID))))
        files.append(File(domain: BackupStore.messageAttachments.domain, path: attachment, content: bytes(31, seed: 5), protectionClass: 2))
        files.append(File(domain: BackupStore.messageAttachments.domain, path: "Library/SMS/Attachments/ef/03/unnamed.pluginPayloadAttachment", content: bytes(64, seed: 6), protectionClass: 2))

        var media: [(pointer: String, content: Data)] = []
        for (index, length) in whatsAppMedia.enumerated() {
            media.append((whatsAppPointer(index), bytes(length, seed: UInt8(truncatingIfNeeded: 40 + index))))
        }
        let (chats, log) = try walDatabase(chatsSQL(pointers: media.map(\.pointer)), log: chatsLogSQL)
        files.append(File(domain: BackupStore.whatsAppChats.domain, path: BackupStore.whatsAppChats.path, content: chats, protectionClass: 3))
        files.append(File(domain: BackupStore.whatsAppChats.domain, path: BackupStore.wal(of: BackupStore.whatsAppChats.path), content: log, protectionClass: 3))
        for medium in media {
            files.append(File(domain: BackupStore.whatsAppDomain, path: BackupStore.whatsAppMessage.prefix + medium.pointer, content: medium.content, protectionClass: 3))
        }
        files.append(File(domain: BackupStore.whatsAppDomain, path: "Message/Media/Profile/\(friendJID)-thumb.jpg", content: bytes(48, seed: 7), protectionClass: 3))
        files.append(File(domain: BackupStore.whatsAppCalls.domain, path: BackupStore.whatsAppCalls.path, content: try database(whatsAppCallsSQL), protectionClass: 3))
        files.append(File(domain: BackupStore.whatsAppPreferences.domain, path: BackupStore.whatsAppPreferences.path,
                          content: try PropertyListSerialization.data(fromPropertyList: ["OwnJabberID": ownJID, "Unrelated": "yes"], format: .binary, options: 0),
                          protectionClass: 3))
        if calls {
            files.append(File(domain: BackupStore.calls.domain, path: BackupStore.calls.path, content: try database(callHistorySQL), protectionClass: 1))
        }
        return files.sorted { ($0.domain, $0.path) < ($1.domain, $1.path) }
    }

    public static func whatsAppPointer(_ index: Int) -> String {
        "Media/\(friendJID)/a/b/00000000-0000-0000-0000-\(String(format: "%012d", index)).bin"
    }

    static func messagesSQL(attachment: String, appleID: String = appleID) -> String {
        """
        CREATE TABLE _SqliteDatabaseProperties (key TEXT, value TEXT, UNIQUE(key));
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT);
        CREATE TABLE chat (
          ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT,
          properties BLOB, chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT, is_archived INTEGER DEFAULT 0,
          last_addressed_handle TEXT, display_name TEXT, group_id TEXT, is_filtered INTEGER, successful_query INTEGER,
          last_read_message_timestamp INTEGER DEFAULT 0);
        CREATE TABLE message (
          ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT NOT NULL, text TEXT, replace INTEGER DEFAULT 0,
          service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, country TEXT, attributedBody BLOB, version INTEGER DEFAULT 0,
          type INTEGER DEFAULT 0, service TEXT, account TEXT, account_guid TEXT, error INTEGER DEFAULT 0, date INTEGER,
          date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0,
          is_emote INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, is_empty INTEGER DEFAULT 0, is_delayed INTEGER DEFAULT 0,
          is_auto_reply INTEGER DEFAULT 0, is_prepared INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0,
          is_sent INTEGER DEFAULT 0, has_dd_results INTEGER DEFAULT 0, is_played INTEGER DEFAULT 0, was_downgraded INTEGER DEFAULT 0,
          did_notify_recipient INTEGER DEFAULT 0, cache_roomnames TEXT, associated_message_guid TEXT,
          associated_message_type INTEGER DEFAULT 0, message_summary_info BLOB, date_edited INTEGER DEFAULT 0,
          date_retracted INTEGER DEFAULT 0, flags INTEGER DEFAULT 0);
        CREATE TABLE attachment (
          ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0, filename TEXT,
          uti TEXT, mime_type TEXT, transfer_state INTEGER DEFAULT 0, is_outgoing INTEGER DEFAULT 0, transfer_name TEXT, total_bytes INTEGER DEFAULT 0);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER, UNIQUE(chat_id, handle_id));
        CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER, UNIQUE(message_id, attachment_id));
        INSERT INTO _SqliteDatabaseProperties (key, value) VALUES ('_ClientVersion', '19201');
        INSERT INTO handle VALUES (1, '+15550000002', 'us', 'iMessage', NULL), (2, '+15550000003', 'us', 'SMS', NULL);
        INSERT INTO chat (ROWID, guid, style, chat_identifier, service_name, account_login) VALUES
          (1, 'iMessage;-;+15550000002', 45, '+15550000002', 'iMessage', 'E:\(appleID.uppercased())'),
          (2, 'SMS;-;+15550000003', 45, '+15550000003', 'SMS', 'p:+15550000001'),
          (3, 'iMessage;-;+15550000004', 45, '+15550000004', 'iMessage', '');
        INSERT INTO chat_handle_join VALUES (1, 1), (2, 2);
        INSERT INTO message (ROWID, guid, text, handle_id, service, account, date, is_from_me) VALUES
          (1, '00000000-0000-0000-0000-00000000B001', 'a synthetic line', 1, 'iMessage', 'e:\(appleID)', 800000000000000000, 0),
          (2, '00000000-0000-0000-0000-00000000B002', 'another synthetic line', 1, 'iMessage', 'e:\(appleID)', 800000060000000000, 1),
          (3, '00000000-0000-0000-0000-00000000B003', 'a synthetic text', 2, 'SMS', 'p:+15550000001', 800000120000000000, 0);
        INSERT INTO chat_message_join VALUES (1, 1, 800000000000000000), (1, 2, 800000060000000000), (2, 3, 800000120000000000);
        INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes) VALUES
          (1, 'at_0_00000000-0000-0000-0000-00000000C001', '~/\(attachment)', 'image/heic', 'IMG_0001.HEIC', 31),
          (2, 'at_0_00000000-0000-0000-0000-00000000C002', '~/Library/SMS/Attachments/cd/02/00000000-0000-0000-0000-00000000A002/IMG_0002.JPG', 'image/jpeg', 'IMG_0002.JPG', 99),
          (3, 'at_0_00000000-0000-0000-0000-00000000C003', '/var/mobile/\(attachment)', 'image/heic', 'IMG_0001.HEIC', 31);
        INSERT INTO message_attachment_join VALUES (2, 1), (2, 2), (1, 3);
        """
    }

    static func chatsSQL(pointers: [String]) -> String {
        var sql = """
        CREATE TABLE ZWAPROFILEPUSHNAME (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZJID VARCHAR, ZPUSHNAME VARCHAR);
        CREATE TABLE ZWACHATSESSION (
          Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCONTACTJID VARCHAR, ZCONTACTIDENTIFIER VARCHAR,
          ZPARTNERNAME VARCHAR, ZSESSIONTYPE INTEGER, ZFLAGS INTEGER, ZARCHIVED INTEGER, ZHIDDEN INTEGER, ZREMOVED INTEGER,
          ZMESSAGECOUNTER INTEGER, ZUNREADCOUNT INTEGER, ZIDENTITYVERIFICATIONSTATE INTEGER, ZIDENTITYVERIFICATIONEPOCH INTEGER,
          ZLASTMESSAGEDATE TIMESTAMP, ZLASTMESSAGETEXT VARCHAR, ZLOCATIONSHARINGENDDATE TIMESTAMP, ZETAG VARCHAR,
          ZSAVEDINPUT VARCHAR, ZSPOTLIGHTSTATUS INTEGER, ZCONTACTABID INTEGER, ZGROUPINFO INTEGER, ZLASTMESSAGE INTEGER,
          ZPROPERTIES BLOB);
        CREATE TABLE ZWAGROUPINFO (
          Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCHATSESSION INTEGER, ZLASTMESSAGEOWNER INTEGER,
          ZPICTUREPATH VARCHAR, ZSTATE INTEGER, ZCREATIONDATE TIMESTAMP, ZSUBJECTTIMESTAMP TIMESTAMP, ZCREATORJID VARCHAR,
          ZOWNERJID VARCHAR, ZSUBJECTOWNERJID VARCHAR, ZSOURCEJID VARCHAR, ZPICTUREID VARCHAR);
        CREATE TABLE ZWAMEDIAITEM (
          Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZFILESIZE INTEGER, ZMEDIAORIGIN INTEGER,
          ZMOVIEDURATION FLOAT, ZASPECTRATIO FLOAT, ZHACCURACY FLOAT, ZLATITUDE FLOAT, ZLONGITUDE FLOAT,
          ZMEDIAURLDATE TIMESTAMP, ZAUTHORNAME VARCHAR, ZCOLLECTIONNAME VARCHAR, ZMEDIAURL VARCHAR, ZTITLE VARCHAR,
          ZVCARDNAME VARCHAR, ZVCARDSTRING VARCHAR, ZMEDIAKEY BLOB, ZMESSAGE INTEGER, ZMEDIALOCALPATH VARCHAR,
          ZTHUMBNAILLOCALPATH VARCHAR, ZXMPPTHUMBPATH VARCHAR, ZCLOUDSTATUS INTEGER, ZMETADATA BLOB);
        CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZMEMBERJID VARCHAR, ZCONTACTIDENTIFIER VARCHAR);
        CREATE TABLE ZWAMESSAGE (
          Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZSORT INTEGER, ZDOCID VARCHAR, ZSPOTLIGHTSTATUS INTEGER,
          ZCHATSESSION INTEGER, ZGROUPMEMBER INTEGER, ZLASTSESSION INTEGER, ZMEDIAITEM INTEGER, ZMESSAGEINFO INTEGER,
          ZPARENTMESSAGE INTEGER, ZSTANZAID VARCHAR, ZTEXT VARCHAR, ZFROMJID VARCHAR, ZTOJID VARCHAR, ZPUSHNAME VARCHAR,
          ZMESSAGEDATE TIMESTAMP, ZSENTDATE TIMESTAMP, ZMESSAGETYPE INTEGER, ZGROUPEVENTTYPE INTEGER, ZFLAGS INTEGER,
          ZMESSAGESTATUS INTEGER, ZMESSAGEERRORSTATUS INTEGER, ZISFROMME INTEGER, ZSTARRED INTEGER, ZMEDIASECTIONID VARCHAR,
          ZPHASH VARCHAR, ZENCRETRYCOUNT INTEGER, ZFILTEREDRECIPIENTCOUNT INTEGER, ZCHILDMESSAGESDELIVEREDCOUNT INTEGER,
          ZCHILDMESSAGESPLAYEDCOUNT INTEGER, ZCHILDMESSAGESREADCOUNT INTEGER, ZDATAITEMVERSION INTEGER);
        CREATE TABLE ZWAMESSAGEINFO (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZMESSAGE INTEGER, ZRECEIPTINFO BLOB);
        CREATE TABLE ZWAPROFILEPICTUREITEM (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZJID VARCHAR, ZTHUMBNAILDATA BLOB);
        INSERT INTO ZWACHATSESSION (Z_PK, ZCONTACTJID, ZPARTNERNAME, ZSESSIONTYPE) VALUES (1, '\(friendJID)', 'Person B', 0);
        INSERT INTO ZWAMESSAGE (Z_PK, ZCHATSESSION, ZSTANZAID, ZTEXT, ZFROMJID, ZTOJID, ZMESSAGEDATE, ZMESSAGETYPE, ZISFROMME) VALUES
          (1, 1, '3A0000000000000000A1', 'a synthetic hello', '\(friendJID)', NULL, 800000000, 0, 0);

        """
        let named = pointers + pointers.prefix(1) + ["Media/\(friendJID)/z/z/not-in-the-backup.jpg"]
        for (index, pointer) in named.enumerated() {
            let pk = index + 1, message = index + 10
            sql += "INSERT INTO ZWAMEDIAITEM (Z_PK, ZMESSAGE, ZMEDIALOCALPATH) VALUES (\(pk), \(message), '\(pointer)');\n"
            sql += "INSERT INTO ZWAMESSAGE (Z_PK, ZCHATSESSION, ZMEDIAITEM, ZSTANZAID, ZFROMJID, ZMESSAGEDATE, ZMESSAGETYPE, ZISFROMME) VALUES (\(message), 1, \(pk), '3A00000000000000M\(String(format: "%03d", index))', '\(friendJID)', \(800000100 + index), 1, 0);\n"
        }
        sql += "INSERT INTO ZWAMEDIAITEM (Z_PK, ZMESSAGE, ZMEDIALOCALPATH) VALUES (\(named.count + 1), NULL, NULL);\n"
        return sql
    }

    public static let logOnlyStanza = "3A0000000000000000A2"
    static let chatsLogSQL = """
        INSERT INTO ZWAMESSAGE (Z_PK, ZCHATSESSION, ZSTANZAID, ZTEXT, ZFROMJID, ZTOJID, ZMESSAGEDATE, ZMESSAGETYPE, ZISFROMME) VALUES
          (2, 1, '\(logOnlyStanza)', 'a synthetic reply, in the log alone', NULL, '\(friendJID)', 800000200, 0, 1);
        """

    static let whatsAppCallsSQL = """
        CREATE TABLE ZWAAGGREGATECALLEVENT (
          Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZINCOMING INTEGER, ZMISSED INTEGER, ZMISSEDREASON INTEGER,
          ZVIDEO INTEGER, ZFIRSTDATE, ZLINKTOKEN VARCHAR);
        CREATE TABLE ZWACDCALLEVENT (
          Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZBYTESRECEIVED INTEGER, ZBYTESSENT INTEGER,
          ZISBOTGROUPCALL INTEGER, ZISLIGHTWEIGHT INTEGER, ZOUTCOME INTEGER, Z1CALLEVENTS INTEGER, Z_FOK_1CALLEVENTS INTEGER,
          ZDATE, ZDURATION FLOAT, ZCALLIDSTRING VARCHAR, ZGROUPCALLCREATORUSERJIDSTRING VARCHAR, ZGROUPJIDSTRING VARCHAR,
          ZREMINDERID VARCHAR, ZSCHEDULEDID VARCHAR);
        CREATE TABLE ZWACDCALLEVENTPARTICIPANT (
          Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOUTCOME INTEGER, Z1PARTICIPANTS INTEGER,
          Z_FOK_1PARTICIPANTS INTEGER, ZJIDSTRING VARCHAR);
        INSERT INTO ZWAAGGREGATECALLEVENT (Z_PK, ZINCOMING, ZMISSED, ZVIDEO, ZFIRSTDATE) VALUES (1, 1, 0, 0, 800000300);
        INSERT INTO ZWACDCALLEVENT (Z_PK, ZOUTCOME, Z1CALLEVENTS, ZDATE, ZDURATION, ZCALLIDSTRING) VALUES (1, 1, 1, 800000300, 42, '00000000000000000000000000000C01');
        INSERT INTO ZWACDCALLEVENTPARTICIPANT (Z_PK, ZOUTCOME, Z1PARTICIPANTS, ZJIDSTRING) VALUES (1, 1, 1, '\(friendJID)');
        """

    static let callHistorySQL = """
        CREATE TABLE ZCALLRECORD ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZANSWERED INTEGER, ZAUTOANSWEREDREASON INTEGER, ZCALLDIRECTORYIDENTITYTYPE INTEGER, ZCALL_CATEGORY INTEGER, ZCALLTYPE INTEGER, ZDISCONNECTED_CAUSE INTEGER, ZFACE_TIME_DATA INTEGER, ZFILTERED_OUT_REASON INTEGER, ZHANDLE_TYPE INTEGER, ZHASMESSAGE INTEGER, ZJUNKCONFIDENCE INTEGER, ZNUMBER_AVAILABILITY INTEGER, ZORIGINATED INTEGER, ZREAD INTEGER, ZSCREENSHARINGTYPE INTEGER, ZUSEDEMERGENCYVIDEOSTREAMING INTEGER, ZVERIFICATIONSTATUS INTEGER, ZWASEMERGENCYCALL INTEGER, ZINITIATOR INTEGER, ZDATE TIMESTAMP, ZDURATION FLOAT, ZADDRESS VARCHAR, ZBLOCKEDBYEXTENSION VARCHAR, ZBLOCKEDBYEXTENSIONNAME VARCHAR, ZIDENTITYEXTENSION VARCHAR, ZISO_COUNTRY_CODE VARCHAR, ZJUNKIDENTIFICATIONCATEGORY VARCHAR, ZLOCATION VARCHAR, ZNAME VARCHAR, ZSERVICE_PROVIDER VARCHAR, ZUNIQUE_ID VARCHAR, ZCONVERSATIONID BLOB, ZIMAGEURL VARCHAR, ZLOCALPARTICIPANTUUID BLOB, ZOUTGOINGLOCALPARTICIPANTUUID BLOB, ZPARTICIPANTGROUPUUID BLOB, ZCOMMUNICATIONTRUSTSCORE INTEGER, ZREMINDERUUID BLOB, ZNEEDEDSCANNOUNCEMENT INTEGER, ZORIGINATINGUITYPE INTEGER, ZORIGINATINGDEVICENAME VARCHAR);
        CREATE TABLE ZHANDLE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZTYPE INTEGER, ZNORMALIZEDVALUE VARCHAR, ZVALUE VARCHAR );
        CREATE TABLE Z_2REMOTEPARTICIPANTHANDLES ( Z_2REMOTEPARTICIPANTCALLS INTEGER, Z_4REMOTEPARTICIPANTHANDLES INTEGER, PRIMARY KEY (Z_2REMOTEPARTICIPANTCALLS, Z_4REMOTEPARTICIPANTHANDLES) );
        CREATE TABLE ZEMERGENCYMEDIAITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZEMERGENCYMEDIATYPE INTEGER, ZUPLOADEDFORCALL INTEGER, ZASSETID VARCHAR );
        CREATE TABLE Z_METADATA (Z_VERSION INTEGER PRIMARY KEY, Z_UUID VARCHAR(255), Z_PLIST BLOB);
        CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
        INSERT INTO ZHANDLE VALUES (1, 4, 1, 2, '+15550000003', '+15550000003'), (2, 4, 1, 3, 'person-c@example.com', 'person-c@example.com');
        INSERT INTO ZCALLRECORD (Z_PK, ZANSWERED, ZCALLTYPE, ZORIGINATED, ZDATE, ZDURATION, ZADDRESS, ZSERVICE_PROVIDER, ZUNIQUE_ID) VALUES
          (1, 1, 1, 0, 800000400, 61, '+15550000003', 'com.apple.Telephony', '00000000-0000-0000-0000-00000000D001'),
          (2, 1, 8, 1, 800000500, 120, 'person-c@example.com', 'com.apple.FaceTime', '00000000-0000-0000-0000-00000000D002');
        INSERT INTO Z_2REMOTEPARTICIPANTHANDLES VALUES (1, 1), (2, 2);
        """


    public static func database(_ sql: String) throws -> Data {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("synthetic-store-\(UUID().uuidString).sqlite")
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            let db = try open(url)
            defer { sqlite3_close(db) }
            try exec(db, sql)
        }
        return try Data(contentsOf: url)
    }

    public static func walDatabase(_ sql: String, log: String) throws -> (database: Data, log: Data) {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("synthetic-wal-\(UUID().uuidString).sqlite")
        defer { for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: url.path + suffix) } }
        let db = try open(url)
        defer { sqlite3_close(db) }
        try exec(db, "PRAGMA journal_mode=WAL")
        try exec(db, sql)
        try exec(db, "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0")
        try exec(db, log)
        return (try Data(contentsOf: url), try Data(contentsOf: URL(fileURLWithPath: url.path + "-wal")))
    }

    private static func open(_ url: URL) throws -> OpaquePointer {
        var db: OpaquePointer?
        guard sqlite3_open(url.path, &db) == SQLITE_OK, let db else { sqlite3_close(db); throw Failed(description: "\(url.lastPathComponent) did not open") }
        return db
    }

    private static func exec(_ db: OpaquePointer, _ sql: String) throws {
        var error: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &error) == SQLITE_OK else {
            defer { sqlite3_free(error) }
            throw Failed(description: error.map { String(cString: $0) } ?? "SQL failed")
        }
    }


    @objc(SyntheticBackupMBFile) final class MBFile: NSObject, NSCoding {
        let size: Int64, protectionClass: Int, encryptionKey: Data?
        init(size: Int64, protectionClass: Int, encryptionKey: Data?) {
            self.size = size; self.protectionClass = protectionClass; self.encryptionKey = encryptionKey
        }
        required init?(coder: NSCoder) { return nil }
        func encode(with coder: NSCoder) {
            coder.encode(size, forKey: "Size")
            coder.encode(protectionClass, forKey: "ProtectionClass")
            coder.encode(0o100644, forKey: "Mode")
            coder.encode(Int64(1_787_916_000), forKey: "LastModified")
            if let encryptionKey { coder.encode(encryptionKey as NSData, forKey: "EncryptionKey") }
        }
    }

    public static func record(size: Int64, protectionClass: Int, encryptionKey: Data?) -> Data {
        let archiver = NSKeyedArchiver(requiringSecureCoding: false)
        archiver.setClassName("MBFile", for: MBFile.self)
        archiver.encode(MBFile(size: size, protectionClass: protectionClass, encryptionKey: encryptionKey), forKey: NSKeyedArchiveRootObjectKey)
        archiver.finishEncoding()
        return archiver.encodedData
    }

    private static func fileList(files: [File], classKeys: [UInt32: Data], encrypted: Bool, at url: URL) throws -> Data {
        let dbUrl = url.appendingPathComponent("Manifest-plain.db")
        defer { for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: dbUrl.path + suffix) } }
        try writeFiles(files, classKeys: classKeys, encrypted: encrypted, at: url, list: dbUrl)
        return try Data(contentsOf: dbUrl)
    }

    private static func writeFiles(_ files: [File], classKeys: [UInt32: Data], encrypted: Bool, at url: URL, list dbUrl: URL) throws {
        let db = try open(dbUrl)
        defer { sqlite3_close(db) }
        try exec(db, "PRAGMA journal_mode=WAL")
        try exec(db, "CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)")
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for file in files {
            let fileID = Insecure.SHA1.hash(data: Data("\(file.domain)-\(file.path)".utf8)).map { String(format: "%02x", $0) }.joined()
            let folder = url.appendingPathComponent(String(fileID.prefix(2)))
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let record: Data
            if encrypted {
                let key = random(32)
                let wrapped = classed(file.protectionClass, wrapped: try wrap(key, with: classKeys[file.protectionClass]!))
                try encrypt(file.content, key: key).write(to: folder.appendingPathComponent(fileID))
                record = file.record ?? Self.record(size: Int64(file.content.count) + file.stale, protectionClass: Int(file.protectionClass), encryptionKey: wrapped)
            } else {
                try file.content.write(to: folder.appendingPathComponent(fileID))
                record = file.record ?? Self.record(size: Int64(file.content.count) + file.stale, protectionClass: 0, encryptionKey: nil)
            }
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, "INSERT INTO Files VALUES (?, ?, ?, 1, ?)", -1, &statement, nil) == SQLITE_OK else { throw Failed(description: "the file list did not take a row") }
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_text(statement, 1, fileID, -1, transient)
            sqlite3_bind_text(statement, 2, file.domain, -1, transient)
            sqlite3_bind_text(statement, 3, file.path, -1, transient)
            _ = record.withUnsafeBytes { sqlite3_bind_blob(statement, 4, $0.baseAddress, Int32($0.count), transient) }
            guard sqlite3_step(statement) == SQLITE_DONE else { throw Failed(description: "the file list did not take \(file.path)") }
        }
    }

    private static func keybag(password: String, classKeys: [UInt32: Data]) throws -> Data {
        let salt = random(20), doubleSalt = random(20)
        let rounds: UInt32 = 1_000, doubleRounds: UInt32 = 1_000
        let first = try pbkdf2(CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), Data(password.utf8), salt: doubleSalt, rounds: doubleRounds)
        let kek = try pbkdf2(CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), first, salt: salt, rounds: rounds)
        var bag = Data()
        func field(_ tag: String, _ value: Data) {
            bag.append(contentsOf: Array(tag.utf8))
            var length = UInt32(value.count).bigEndian
            bag.append(Data(bytes: &length, count: 4))
            bag.append(value)
        }
        func number(_ value: UInt32) -> Data { var big = value.bigEndian; return Data(bytes: &big, count: 4) }
        field("VERS", number(4)); field("TYPE", number(1)); field("UUID", random(16)); field("HMCK", random(40)); field("WRAP", number(1))
        field("SALT", salt); field("ITER", number(rounds)); field("DPWT", number(0)); field("DPIC", number(doubleRounds)); field("DPSL", doubleSalt)
        for (classNumber, key) in classKeys.sorted(by: { $0.key < $1.key }) {
            field("UUID", random(16)); field("CLAS", number(classNumber)); field("WRAP", number(2)); field("KTYP", number(0))
            field("WPKY", try wrap(key, with: kek))
        }
        return bag
    }

    private static func pbkdf2(_ prf: CCPseudoRandomAlgorithm, _ password: Data, salt: Data, rounds: UInt32) throws -> Data {
        var derived = Data(count: 32)
        let status = password.withUnsafeBytes { passwordBytes in
            salt.withUnsafeBytes { saltBytes in
                derived.withUnsafeMutableBytes { out in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), passwordBytes.baseAddress?.assumingMemoryBound(to: Int8.self), passwordBytes.count,
                                         saltBytes.baseAddress?.assumingMemoryBound(to: UInt8.self), saltBytes.count, prf, rounds,
                                         out.baseAddress?.assumingMemoryBound(to: UInt8.self), out.count)
                }
            }
        }
        guard status == kCCSuccess else { throw Failed(description: "PBKDF2 failed (\(status))") }
        return derived
    }

    private static func classed(_ number: UInt32, wrapped: Data) -> Data {
        var little = number.littleEndian
        return Data(bytes: &little, count: 4) + wrapped
    }

    private static func wrap(_ key: Data, with kek: Data) throws -> Data {
        var out = Data(count: 40)
        var outLength = 40
        let status = kek.withUnsafeBytes { kekBytes in
            key.withUnsafeBytes { keyBytes in
                out.withUnsafeMutableBytes { outBytes in
                    CCSymmetricKeyWrap(CCWrappingAlgorithm(kCCWRAPAES), CCrfc3394_iv, CCrfc3394_ivLen,
                                       kekBytes.baseAddress?.assumingMemoryBound(to: UInt8.self), kekBytes.count,
                                       keyBytes.baseAddress?.assumingMemoryBound(to: UInt8.self), keyBytes.count,
                                       outBytes.baseAddress?.assumingMemoryBound(to: UInt8.self), &outLength)
                }
            }
        }
        guard status == kCCSuccess else { throw Failed(description: "the key wrap failed (\(status))") }
        return out
    }

    private static func encrypt(_ plain: Data, key: Data) throws -> Data {
        var out = Data(count: plain.count + 16)
        var moved = 0
        let iv = [UInt8](repeating: 0, count: 16)
        let status = key.withUnsafeBytes { keyBytes in
            plain.withUnsafeBytes { inBytes in
                out.withUnsafeMutableBytes { outBytes in
                    CCCrypt(CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
                            keyBytes.baseAddress, keyBytes.count, iv, inBytes.baseAddress, inBytes.count, outBytes.baseAddress, outBytes.count, &moved)
                }
            }
        }
        guard status == kCCSuccess else { throw Failed(description: "AES failed (\(status))") }
        return out.prefix(moved)
    }

    private static func random(_ count: Int) -> Data {
        var data = Data(count: count)
        _ = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
        return data
    }
}
