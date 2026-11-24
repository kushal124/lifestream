import Foundation
import HomeLink

extension CaptureStore {
    public static let madeByPerson: Set<CaptureDomain> = [.checkin, .notes]

    static let restoredFact = "restored"
    static let sinceFact = "since"
    static let restoreOwed = "owed"

    static func createAnchors(in database: SQLiteDatabase) throws {
        try database.execute("CREATE TABLE IF NOT EXISTS anchor (key TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID")
    }

    public var isRestored: Bool { restoredBy != nil }

    public var isPaired: Bool { paired }

    public func setPaired(_ paired: Bool) { self.paired = paired }

    public var historyReadsAdmitted: Bool { restoredBy != nil || !paired }

    public func since(_ domain: CaptureDomain) throws -> Date? {
        guard let text = try Self.fact(Self.sinceFact, in: database),
              let stated = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let ms = stated[domain.rawValue] as? Double else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }

    public func sinceTypes(_ domain: CaptureDomain) throws -> Set<String> {
        guard let text = try Self.fact(Self.sinceTypesFact, in: database),
              let stated = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: [String]] else { return [] }
        return Set(stated[domain.rawValue] ?? [])
    }

    static let sinceTypesFact = "since-types"


    public struct ReadPoint: Sendable, Equatable, Codable {
        public let at: String
        public let types: [String]?

        public init(at: Date, types: [String]? = nil) {
            self.at = CaptureTime.rfc3339(at); self.types = types
        }
    }

    public func setReadPoint(_ domain: CaptureDomain, _ point: ReadPoint) throws {
        let text = String(decoding: try JSONEncoder.lifestream().encode(point), as: UTF8.self)
        try save(cause: "read-point") { try Self.setFact(Self.readPointFact + domain.rawValue, text, in: database) }
    }

    public func readPoints() throws -> [CaptureDomain: ReadPoint] {
        var points: [CaptureDomain: ReadPoint] = [:]
        for domain in CaptureDomain.allCases {
            guard let text = try Self.fact(Self.readPointFact + domain.rawValue, in: database) else { continue }
            points[domain] = try JSONDecoder.lifestream().decode(ReadPoint.self, from: Data(text.utf8))
        }
        return points
    }

    static let readPointFact = "read-point."

    public func restore(_ restore: Restore, pass: String) throws {
        guard restoredBy == nil else { return }
        let sources = PhoneCustody.sources(restore.sources)
        let encoder = JSONEncoder.lifestream()
        let decoder = JSONDecoder()
        try database.write {
            for (name, entries) in restore.domains.sorted(by: { $0.key < $1.key }) {
                guard let domain = CaptureDomain(rawValue: name), Self.madeByPerson.contains(domain),
                      let source = sources[domain], !entries.isEmpty, try lastSequence(domain) == 0 else { continue }
                let first: UInt64 = 1
                var next = first
                for restored in entries {
                    let payload = try decoder.decode(JSONValue.self, from: restored.payload)
                    let entry = try CaptureEntry(
                        domain: domain, kind: restored.kind, sequence: next, observedAt: restored.observedAt,
                        captured: .init(), processInstanceID: processInstanceID,
                        captureReplayKey: nil, payload: payload)
                    try database.run(
                        "INSERT INTO \(domain.table) (sequence, kind, captured_wall, replay_key, line) VALUES (?, ?, ?, NULL, ?)",
                        .integer(Int64(next)), .text(entry.kind), .real(entry.captured.wallUnixSeconds), .blob(try encoder.encode(entry)))
                    next += 1
                }
                try database.run(
                    "INSERT OR REPLACE INTO ledger (pass, source, seal, first_sequence, last_sequence) VALUES (?, ?, 0, ?, ?)",
                    .text(pass), .text(source), .integer(Int64(first)), .integer(Int64(next - 1)))
            }
            var since: [String: Double] = [:]
            for (domain, source) in sources { if let date = restore.since[source] { since[domain.rawValue] = date.timeIntervalSince1970 * 1000 } }
            let text = String(decoding: try JSONSerialization.data(withJSONObject: since, options: [.sortedKeys]), as: UTF8.self)
            try Self.setFact(Self.sinceFact, text, in: database)
            var types: [String: [String]] = [:]
            for (domain, source) in sources { if let covered = restore.types[source] { types[domain.rawValue] = covered.sorted() } }
            let typesText = String(decoding: try JSONSerialization.data(withJSONObject: types, options: [.sortedKeys]), as: UTF8.self)
            try Self.setFact(Self.sinceTypesFact, typesText, in: database)
            if let source = sources[.contacts], let ids = restore.contacts[source], !ids.isEmpty { try seedContacts(ids) }
            try Self.setFact(Self.restoredFact, pass, in: database)
        }
        restoredBy = pass
    }


    static let stoppedFact = "stopped"

    func admit(_ domain: CaptureDomain) throws {
        if stopped { throw CaptureError.stopped }
        if restoredBy == nil, paired, Self.madeByPerson.contains(domain) { throw CaptureError.restorePending(domain) }
        try admit(bytes: 0)
    }

    func admit(bytes: Int64) throws {
        guard volume.fits(.new, bytes: bytes) else { throw CaptureError.full }
    }

    public func markStopped(at date: Date) throws {
        guard !stopped else { return }
        try save(cause: "stopped") { try Self.setFact(Self.stoppedFact, CaptureTime.rfc3339(date), in: database) }
        stopped = true
    }

    public var isStopped: Bool { stopped }


    public struct FirstRun: Sendable, Equatable, Codable {
        public var past: Set<String>
        public var started: Bool
        public var askedAlways: Bool

        public init(past: Set<String> = [], started: Bool = false, askedAlways: Bool = false) {
            self.past = past; self.started = started; self.askedAlways = askedAlways
        }
    }

    static let firstRunFact = "first-run"

    public func setFirstRun(_ firstRun: FirstRun) throws {
        let text = String(decoding: try JSONEncoder.lifestream().encode(firstRun), as: UTF8.self)
        try database.write { try Self.setFact(Self.firstRunFact, text, in: database) }
    }


    public func anchor(_ key: String) throws -> Data? {
        var value: Data?
        try database.query("SELECT value FROM anchor WHERE key = ?", .text(key)) { value = $0.blob(0) }
        return value
    }

    public func anchors(prefix: String) throws -> [String: Data] {
        var found: [String: Data] = [:]
        try database.query("SELECT key, value FROM anchor WHERE key >= ? AND key < ?", .text(prefix), .text(prefix + "\u{10FFFF}")) { row in
            if let key = row.text(0) { found[key] = row.blob(1) }
        }
        return found
    }

    public func setAnchor(_ key: String, _ value: Data?) throws {
        try database.write(cause: "anchor") { try writeAnchor(key, value) }
    }

    func writeAnchor(_ key: String, _ value: Data?) throws {
        if let value {
            _ = try database.run("INSERT OR REPLACE INTO anchor (key, value) VALUES (?, ?)", .text(key), .blob(value))
        } else {
            _ = try database.run("DELETE FROM anchor WHERE key = ?", .text(key))
        }
    }
}
