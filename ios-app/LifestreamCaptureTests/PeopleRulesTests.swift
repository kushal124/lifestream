import HomeLink
import LifestreamCaptureCore
import XCTest
@testable import Lifestream

@MainActor
final class PeopleRulesTests: XCTestCase {
    func testANumberIsGroupedAsDialled() {
        XCTAssertEqual(PeopleWords.dialled("+15550000001"), "+1 555 000 0001")
        XCTAssertEqual(PeopleWords.dialled("+919000000001"), "+91 90000 00001")
        XCTAssertEqual(PeopleWords.dialled("+447700900123"), "+44 7700 900123")
    }

    func testAnyOtherNumberStandsAsTheHomeWroteIt() {
        for kept in ["+33612345678", "+1555000000", "+1 555 000 0001", "15550000001", "Hidden number", "person-a@example.com", ""] {
            XCTAssertEqual(PeopleWords.dialled(kept), kept)
        }
    }


    func testAWhatsAppChatIdIsKeyedWhatsApp() throws {
        let whatsApp = PeopleWords.network("whatsapp")
        XCTAssertNotEqual(whatsApp, "Account")
        let hidden = try handle(#"{"id":"jid:100000000000001@lid","kind":"jid","network":null,"words":"Hidden number","from":null,"own":false}"#)
        XCTAssertEqual(EditWords.handle(hidden).key, whatsApp)
        XCTAssertEqual(EditWords.handle(hidden).value, "Number hidden")
        let shown = try handle(#"{"id":"jid:15550000002@s.whatsapp.net","kind":"jid","network":null,"words":"+15550000002","from":null,"own":false}"#)
        XCTAssertEqual(EditWords.handle(shown).key, whatsApp)
        XCTAssertEqual(EditWords.handle(shown).value, "+1 555 000 0002", "its number grouped as dialled")
    }

    private func handle(_ json: String) throws -> PersonCard.Handle {
        try JSONDecoder().decode(PersonCard.Handle.self, from: Data(json.utf8))
    }
}
