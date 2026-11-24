import Darwin
import Foundation
import SQLite3
import XCTest
@testable import Shipping

final class SQLiteSourceTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("sqlite-source-tests")
    }

    override func tearDownWithError() throws {
        chmod(folder.path, 0o755)
        for name in (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? [] {
            chmod(folder.appendingPathComponent(name).path, 0o644)
        }
        try? FileManager.default.removeItem(at: root)
    }

    private var folder: URL { root.appendingPathComponent("App Support", isDirectory: true) }
    private var database: URL { folder.appendingPathComponent("store.sqlite") }
    private var output: URL { root.appendingPathComponent("output.sqlite") }

    private static let schema = ["CREATE TABLE entry (id INTEGER PRIMARY KEY, body TEXT)",
                                 "CREATE TABLE tally (id INTEGER PRIMARY KEY, entries INTEGER)",
                                 "INSERT INTO tally VALUES (1, 0)"]

    private static func entries(_ range: ClosedRange<Int>) -> [String] {
        ["BEGIN",
         "INSERT INTO entry (id, body) VALUES " + range.map { "(\($0), 'synthetic \($0)')" }.joined(separator: ", "),
         "UPDATE tally SET entries = (SELECT count(*) FROM entry)",
         "COMMIT"]
    }

    private func count(_ url: URL) throws -> Int? {
        try SQLite.integer("SELECT count(*) FROM entry", in: url)
    }


    func testAClosedWALDatabaseReadsThroughAHeldCopy() throws {
        try DomainFixtures.closedWAL(database, Self.schema + Self.entries(1...2_567))
        XCTAssertEqual(Self.header(database), [2, 2], "the fixture is a WAL database")
        let before = try DomainFixtures.stamps(in: folder)
        XCTAssertEqual(before.keys.sorted(), ["store.sqlite"], "the writer left no sidecar")
        XCTAssertThrowsError(try count(database)) { error in
            XCTAssertTrue("\(error)".contains("unable to open database file"), "\(error)")
        }

        let source = try SQLiteSource(database, scratch: DomainFixtures.sealScratch)
        XCTAssertNotEqual(source.url, database, "a closed WAL database is read through a held copy")
        XCTAssertEqual(source.url.lastPathComponent, "store.sqlite")
        XCTAssertEqual(Self.header(source.url), [1, 1], "the copy reads with no sidecar beside it")
        XCTAssertEqual(try count(source.url), 2_567)
        try SQLiteDelta.write(from: source, to: output, tables: { _, _ in [SQLiteDelta.Table("entry")] })
        XCTAssertEqual(try count(output), 2_567)
        try SQLiteDelta.write(from: source, to: output, tables: { _, _ in [SQLiteDelta.Table("entry", keep: "id > 2560")] })
        XCTAssertEqual(try count(output), 7)
        source.close()

        XCTAssertEqual(try DomainFixtures.stamps(in: folder), before, "nothing was written beside the source")
        XCTAssertEqual(DomainFixtures.workspaces(SQLiteSource.workPrefix), [])
    }

    func testAWALDatabaseItsWriterHoldsOpenIsReadInPlace() throws {
        let road = StoreFiles(home: root, lifestream: [])
        let writer = try Self.holdOpen(database, entries: 1...40)
        defer { sqlite3_close(writer) }
        XCTAssertEqual(try DomainFixtures.stamps(in: folder).keys.sorted(),
                       ["store.sqlite", "store.sqlite-shm", "store.sqlite-wal"])
        XCTAssertEqual(try DomainFixtures.read("SELECT count(*) FROM entry", from: database), [["40"]])

        let source = try SQLiteSource(database, opener: road.opener, scratch: DomainFixtures.sealScratch)
        defer { source.close() }
        XCTAssertEqual(source.url, database, "a database its WAL writer holds is read in place")
        XCTAssertEqual(DomainFixtures.workspaces(SQLiteSource.workPrefix), [], "no copy is taken")
        try SQLiteDelta.write(from: source, to: output, tables: { _, _ in [SQLiteDelta.Table("entry")] })
        XCTAssertEqual(try count(output), 40, "the rows only the log holds are read")
        XCTAssertEqual(try DomainFixtures.stamps(in: folder).keys.sorted(),
                       ["store.sqlite", "store.sqlite-shm", "store.sqlite-wal"])

        let secret = root.appendingPathComponent(".ssh/store.sqlite")
        try FileManager.default.createDirectory(at: secret.deletingLastPathComponent(), withIntermediateDirectories: true)
        let held = try Self.holdOpen(secret, entries: 1...3)
        defer { sqlite3_close(held) }
        let linkedFolder = root.appendingPathComponent("Linked", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: linkedFolder, withDestinationURL: secret.deletingLastPathComponent())
        let linkedFile = folder.appendingPathComponent("linked.sqlite")
        for suffix in ["", "-wal", "-shm"] {
            try FileManager.default.createSymbolicLink(atPath: linkedFile.path + suffix, withDestinationPath: secret.path + suffix)
        }
        for (path, reason) in [(linkedFolder.appendingPathComponent("store.sqlite"), "a file the store names lies under ~/.ssh, which is never read"),
                               (linkedFile, "a file the store names is a link, which is never opened")] {
            XCTAssertThrowsError(try SQLiteSource(path, opener: road.opener, scratch: DomainFixtures.sealScratch), path.lastPathComponent) {
                XCTAssertEqual(($0 as? StoreFiles.Unsafe)?.reason, reason)
            }
        }
        XCTAssertEqual(DomainFixtures.workspaces(SQLiteSource.workPrefix), [])
    }

    private static func holdOpen(_ url: URL, entries: ClosedRange<Int>) throws -> OpaquePointer {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let writer = try DomainFixtures.openSqlite(url)
        try DomainFixtures.run("PRAGMA journal_mode=WAL", on: writer)
        try DomainFixtures.run("PRAGMA wal_autocheckpoint=0", on: writer)
        for statement in schema + Self.entries(entries) { try DomainFixtures.run(statement, on: writer) }
        return writer
    }

    func testALogWithNoIndexKeepsItsFrames() throws {
        let live = root.appendingPathComponent("live.sqlite")
        let writer = try DomainFixtures.openSqlite(live)
        defer { sqlite3_close(writer) }
        try DomainFixtures.run("PRAGMA journal_mode=WAL", on: writer)
        try DomainFixtures.run("PRAGMA wal_autocheckpoint=0", on: writer)
        for statement in Self.schema + Self.entries(1...10) { try DomainFixtures.run(statement, on: writer) }
        try DomainFixtures.run("PRAGMA wal_checkpoint(TRUNCATE)", on: writer)
        for statement in Self.entries(11...30) { try DomainFixtures.run(statement, on: writer) }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: live, to: database)
        try FileManager.default.copyItem(atPath: live.path + "-wal", toPath: database.path + "-wal")
        let before = try DomainFixtures.stamps(in: folder)
        XCTAssertEqual(before.keys.sorted(), ["store.sqlite", "store.sqlite-wal"])
        let alone = root.appendingPathComponent("alone.sqlite")
        try FileManager.default.copyItem(at: database, to: alone)
        try DomainFixtures.sqlite(alone, ["PRAGMA journal_mode=DELETE"])
        XCTAssertEqual(try DomainFixtures.read("SELECT count(*) FROM entry", from: alone), [["10"]],
                       "twenty entries are only in the log")

        let source = try SQLiteSource(database, scratch: DomainFixtures.sealScratch)
        defer { source.close() }
        XCTAssertNotEqual(source.url, database)
        XCTAssertEqual(try count(source.url), 30, "the log's frames are replayed into the copy")
        XCTAssertEqual(try SQLite.integer("SELECT entries FROM tally", in: source.url), 30)
        XCTAssertEqual(try DomainFixtures.stamps(in: folder), before, "no index was made beside the source")
    }

    func testAnIndexWithNoLogReadsThroughAHeldCopy() throws {
        try DomainFixtures.closedWAL(database, Self.schema + Self.entries(1...5))
        FileManager.default.createFile(atPath: database.path + "-shm", contents: Data())
        XCTAssertThrowsError(try count(database), "an index alone is refused in place")

        let source = try SQLiteSource(database, scratch: DomainFixtures.sealScratch)
        defer { source.close() }
        XCTAssertNotEqual(source.url, database)
        XCTAssertEqual(try count(source.url), 5)
        XCTAssertEqual(try DomainFixtures.stamps(in: folder).keys.sorted(), ["store.sqlite", "store.sqlite-shm"])
    }


    func testARollbackDatabaseMidTransactionReadsItsLastCommit() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try DomainFixtures.sqlite(database, Self.schema + Self.entries(1...3_000))
        let writer = try DomainFixtures.openSqlite(database)
        defer { sqlite3_close(writer) }
        try DomainFixtures.run("PRAGMA cache_size=1", on: writer)
        try DomainFixtures.run("PRAGMA cache_spill=1", on: writer)
        try DomainFixtures.run("BEGIN IMMEDIATE", on: writer)
        try DomainFixtures.run("UPDATE entry SET body = body || ' rewritten'", on: writer)
        for statement in Self.entries(3_001...4_000).dropFirst().dropLast() { try DomainFixtures.run(statement, on: writer) }
        XCTAssertGreaterThan(try XCTUnwrap(SQLiteHeldCopy.Stamp.of(database.path + "-journal")).size, 0,
                             "the open transaction keeps its originals in a hot journal")
        XCTAssertThrowsError(try count(database), "the writer's spilled pages lock readers out")

        let source = try SQLiteSource(database, scratch: DomainFixtures.sealScratch)
        defer { source.close() }
        XCTAssertNotEqual(source.url, database, "a rollback database is read through a held copy")
        XCTAssertEqual(try count(source.url), 3_000)
        XCTAssertEqual(try SQLite.integer("SELECT entries FROM tally", in: source.url), 3_000)
        XCTAssertEqual(try SQLite.integer("SELECT count(*) FROM entry WHERE body LIKE '% rewritten'", in: source.url), 0)
        XCTAssertEqual(try DomainFixtures.read("PRAGMA quick_check", from: source.url), [["ok"]])
        try DomainFixtures.run("ROLLBACK", on: writer)
    }


    func testAWriterThatStartsAfterTheStampMovesIt() throws {
        try DomainFixtures.closedWAL(database, Self.schema + Self.entries(1...5))
        let closed = SQLiteHeldCopy.stamps(of: database)
        let writer = try DomainFixtures.openSqlite(database)
        defer { sqlite3_close(writer) }
        for statement in Self.entries(6...7) { try DomainFixtures.run(statement, on: writer) }
        XCTAssertNotEqual(SQLiteHeldCopy.stamps(of: database), closed)
        let rollback = root.appendingPathComponent("rollback.sqlite")
        try DomainFixtures.sqlite(rollback, Self.schema + Self.entries(1...5))
        let committed = SQLiteHeldCopy.stamps(of: rollback)
        try DomainFixtures.sqlite(rollback, Self.entries(6...6))
        XCTAssertNotEqual(SQLiteHeldCopy.stamps(of: rollback), committed)
    }

    func testACopyTakenWhileAWriterCommitsIsNeverTorn() throws {
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try DomainFixtures.sqlite(database, Self.schema + Self.entries(1...200))
        let writer = Writer()
        let path = database
        let thread = Thread {
            defer {
                writer.began.signal()
                writer.finished.signal()
            }
            guard let handle = try? DomainFixtures.openSqlite(path) else { return }
            defer { sqlite3_close(handle) }
            try? DomainFixtures.run("PRAGMA synchronous=OFF", on: handle)
            var next = 201
            while !writer.stopped {
                for statement in Self.entries(next...(next + 9)) { try? DomainFixtures.run(statement, on: handle) }
                next += 10
                if writer.committed() == 1 { writer.began.signal() }
                usleep(3_000)
            }
        }
        thread.start()
        defer { writer.stop() }
        writer.began.wait()
        let before = writer.commits
        guard before > 0 else { return XCTFail("the writer is not committing") }
        var taken = 0
        var settled = 0
        while taken < 20 || writer.commits == before {
            taken += 1
            do {
                let source = try SQLiteSource(database, scratch: DomainFixtures.sealScratch)
                let entries = try XCTUnwrap(try count(source.url))
                XCTAssertEqual(try SQLite.integer("SELECT entries FROM tally", in: source.url), entries)
                XCTAssertEqual(entries % 10, 0, "a copy holds whole commits")
                settled += 1
                source.close()
            } catch let error as SQLiteHeldCopyError {
                guard case .unsettled = error else { return XCTFail("\(error)") }
            }
        }
        XCTAssertEqual(DomainFixtures.workspaces(SQLiteSource.workPrefix), [], "\(settled) of \(taken) settled")
    }


    func testASourceInAFolderTheReaderMayNotWriteIsReadAndNotTouched() throws {
        try DomainFixtures.closedWAL(database, Self.schema + Self.entries(1...12))
        let crashed = folder.appendingPathComponent("crashed.sqlite")
        try FileManager.default.copyItem(at: database, to: crashed)
        FileManager.default.createFile(atPath: crashed.path + "-wal", contents: Data())
        let before = try DomainFixtures.stamps(in: folder)
        XCTAssertEqual(chmod(folder.path, 0o555), 0)

        for file in [database, crashed] {
            let source = try SQLiteSource(file, scratch: DomainFixtures.sealScratch)
            XCTAssertEqual(try count(source.url), 12, file.lastPathComponent)
            source.close()
        }
        XCTAssertEqual(try DomainFixtures.stamps(in: folder), before)
    }

    func testAFolderTheReaderMayNotEnterIsADenialNotAMissingFile() throws {
        try DomainFixtures.closedWAL(database, Self.schema)
        XCTAssertEqual(chmod(folder.path, 0o000), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: database.path), "Foundation reads a denial as absence")

        XCTAssertThrowsError(try SQLiteSource(database, scratch: DomainFixtures.sealScratch)) { error in
            XCTAssertEqual(error as? SQLiteError, .denied("store.sqlite", "Permission denied"))
            XCTAssertEqual("\(error)", "store.sqlite cannot be read: Permission denied")
        }
        XCTAssertEqual(DomainFixtures.workspaces(SQLiteSource.workPrefix), [])
    }

    func testAFileTheReaderMayNotOpenStatesTheDenial() throws {
        try DomainFixtures.closedWAL(database, Self.schema)
        XCTAssertEqual(chmod(database.path, 0o000), 0)
        XCTAssertThrowsError(try SQLiteSource(database, scratch: DomainFixtures.sealScratch)) { error in
            XCTAssertEqual(error as? SQLiteHeldCopyError, .copy("store.sqlite", "Permission denied"))
        }
        XCTAssertEqual(DomainFixtures.workspaces(SQLiteSource.workPrefix), [])

        let held = folder.appendingPathComponent("held.sqlite")
        try DomainFixtures.closedWAL(held, Self.schema)
        FileManager.default.createFile(atPath: held.path + "-wal", contents: Data())
        FileManager.default.createFile(atPath: held.path + "-shm", contents: Data())
        XCTAssertEqual(chmod(held.path, 0o000), 0)
        let source = try SQLiteSource(held, scratch: DomainFixtures.sealScratch)
        defer { source.close() }
        XCTAssertEqual(source.url, held)
        XCTAssertThrowsError(try count(source.url)) { error in
            XCTAssertEqual("\(error)", "sqlite could not open held.sqlite: unable to open database file (Permission denied)")
        }
    }

    func testAMissingSourceIsNamedMissing() throws {
        XCTAssertThrowsError(try SQLiteSource(database, scratch: DomainFixtures.sealScratch)) { error in
            XCTAssertEqual(error as? SQLiteError, .missing("store.sqlite"))
            XCTAssertEqual("\(error)", "no such database store.sqlite")
        }
        XCTAssertEqual(DomainFixtures.workspaces(SQLiteSource.workPrefix), [])
    }


    func testTheHeldCopyGoesWhenTheReadEnds() throws {
        try DomainFixtures.closedWAL(database, Self.schema + Self.entries(1...3))
        let closed = try SQLiteSource(database, scratch: DomainFixtures.sealScratch)
        XCTAssertEqual(DomainFixtures.workspaces(SQLiteSource.workPrefix).count, 1)
        closed.close()
        closed.close()
        XCTAssertEqual(DomainFixtures.workspaces(SQLiteSource.workPrefix), [])
        do {
            let dropped = try SQLiteSource(database, scratch: DomainFixtures.sealScratch)
            XCTAssertEqual(try count(dropped.url), 3)
        }
        XCTAssertEqual(DomainFixtures.workspaces(SQLiteSource.workPrefix), [])
        XCTAssertThrowsError(try SQLiteDelta.write(from: try SQLiteSource(database, scratch: DomainFixtures.sealScratch), to: output,
                                                   tables: { _, _ in [SQLiteDelta.Table("absent", keep: "FALSE")] }))
        XCTAssertEqual(DomainFixtures.workspaces(SQLiteSource.workPrefix), [])
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
    }

    func testAnErrorNamesTheFileAndNoPath() throws {
        try DomainFixtures.closedWAL(database, Self.schema)
        FileManager.default.createFile(atPath: database.path + "-wal", contents: Data())
        FileManager.default.createFile(atPath: database.path + "-shm", contents: Data())
        XCTAssertEqual(chmod(database.path, 0o000), 0)
        XCTAssertThrowsError(try SQLiteDelta.write(from: try SQLiteSource(database, scratch: DomainFixtures.sealScratch), to: output, tables: { _, _ in [] })) { error in
            XCTAssertEqual("\(error)", "sqlite could not attach store.sqlite read-only: unable to open database: store.sqlite (Permission denied)")
            XCTAssertTrue(error is PathFreeError)
        }
        XCTAssertThrowsError(try SQLite.integer("SELECT 1", in: try SQLiteSource(database, scratch: DomainFixtures.sealScratch).url)) { error in
            XCTAssertEqual("\(error)", "sqlite could not open store.sqlite: unable to open database file (Permission denied)")
        }
        XCTAssertEqual(chmod(database.path, 0o644), 0)
        try FileManager.default.removeItem(atPath: database.path + "-shm")
        try DomainFixtures.write("not a database", to: database)
        XCTAssertThrowsError(try SQLiteSource(database, scratch: DomainFixtures.sealScratch)) { error in
            XCTAssertFalse("\(error)".contains("/"), "\(error)")
            XCTAssertTrue(error is PathFreeError)
        }
    }


    static func header(_ url: URL) -> [UInt8] {
        guard let handle = FileHandle(forReadingAtPath: url.path) else { return [] }
        defer { try? handle.close() }
        try? handle.seek(toOffset: 18)
        return [UInt8](handle.readData(ofLength: 2))
    }

    private final class Writer: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        private var stopping = false
        let began = DispatchSemaphore(value: 0)
        let finished = DispatchSemaphore(value: 0)
        var commits: Int { lock.withLock { count } }
        var stopped: Bool { lock.withLock { stopping } }
        func committed() -> Int {
            lock.withLock {
                count += 1
                return count
            }
        }
        func stop() {
            lock.withLock { stopping = true }
            finished.wait()
        }
    }
}
