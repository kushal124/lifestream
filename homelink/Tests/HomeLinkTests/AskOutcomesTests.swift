import Foundation
import XCTest
@testable import HomeLink

final class AskOutcomesTests: XCTestCase {
    private static let table = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Fixtures/ask-outcomes.json")

    private struct Table: Decodable {
        let cases: [Case]
    }

    private struct Case: Decodable {
        let name: String
        let phase: String
        let answer: Said
        let copies: String
        let turn: String
        let again: String
    }

    private struct Said: Decodable {
        let events: [String]?
        let status: Int?
        let missing: [String]?
        let busy: Bool?
        let lost: Bool?
        let photo: Bool?
    }

    private func answer(_ said: Said) throws -> HomeLink.Ask.Answer {
        if said.lost == true { return .lost }
        if let status = said.status {
            if let missing = said.missing { return missing.contains("audio") ? .noteGone : .missing }
            if said.photo == true { return .photo(status) }
            return status == 503 ? .away : .refused(status)
        }
        let events = try XCTUnwrap(said.events)
        if events.contains("done") { return .done(failed: events.contains("error")) }
        if events.contains("error:erased") { return .error(erased: true) }
        if events.contains("error") { return .error(erased: false) }
        if events.contains("chat") { return .chat }
        return .ended
    }

    func testEveryCaseOfTheTableIsDecidedAsItSays() throws {
        let table = try JSONDecoder().decode(Table.self, from: Data(contentsOf: Self.table))
        XCTAssertEqual(table.cases.count, 20)
        for each in table.cases {
            let phase = try XCTUnwrap(HomeLink.Ask.Phase(rawValue: each.phase), each.name)
            let outcome = HomeLink.Ask.Outcome.of(try answer(each.answer), in: phase)
            XCTAssertEqual(outcome.copies.rawValue, each.copies, each.name)
            XCTAssertEqual(outcome.turn.rawValue, each.turn, each.name)
            XCTAssertEqual(outcome.again.rawValue, each.again, each.name)
        }
    }
}
