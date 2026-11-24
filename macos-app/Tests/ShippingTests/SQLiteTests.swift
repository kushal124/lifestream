import Foundation
import SQLite3
import XCTest
@testable import Shipping

final class SQLiteTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = try DomainFixtures.scratch("sqlite-tests")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private var database: URL { root.appendingPathComponent("store.db") }

    func testColumnsAreTheOnesTheTableDeclares() throws {
        try DomainFixtures.sqlite(database, ["CREATE TABLE ZWAMEDIAITEM (ZMEDIALOCALPATH TEXT, ZXMPPTHUMBPATH TEXT)"])
        XCTAssertEqual(try SQLite.columns(of: "ZWAMEDIAITEM", in: database), ["ZMEDIALOCALPATH", "ZXMPPTHUMBPATH"])
        XCTAssertEqual(try SQLite.columns(of: "ZWACHATSESSION", in: database), [],
                       "a table the database does not hold declares no columns")
    }

    func testACellThatHoldsNoTextIsNilToQueryAndKnownToRows() throws {
        try DomainFixtures.sqlite(database, [
            "CREATE TABLE cell (value)",
            "INSERT INTO cell (value) VALUES ('text'), (NULL), (7)",
        ])
        var seen: [String?] = []
        try SQLite.query("SELECT value FROM cell", in: database) { row in seen.append(row.first ?? nil) }
        XCTAssertEqual(seen, ["text", nil, nil])

        var kinds: [SQLite.Cell] = []
        try SQLite.rows("SELECT value FROM cell", in: database) { cells in kinds.append(cells[0]) }
        XCTAssertEqual(kinds, [.text("text"), .null, .other])
    }

    func testAStatementTheDatabaseCannotAnswerRefuses() throws {
        try DomainFixtures.sqlite(database, ["CREATE TABLE note (body TEXT)"])
        XCTAssertThrowsError(try SQLite.query("SELECT body FROM missing", in: database) { _ in })
    }

    func testBytesThatAreNotADatabaseRefuse() throws {
        try DomainFixtures.write("not a database", to: database)
        XCTAssertThrowsError(try SQLite.integer("SELECT count(*) FROM sqlite_master", in: database))
    }
}
