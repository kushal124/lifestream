import Foundation
import HomeLink
import XCTest

@testable import LifestreamCaptureCore

final class PersonCardTests: XCTestCase {
    private static let id = "phone:+15550000171"
    private static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/pages/canned")
    private static let heads: Set<String> = ["name", "named", "relationship", "entity", "entity_by"]
    private static let tops: Set<String> = ["me", "handles"]
    private static var theirs: [[String: Any]] {
        [["id": "phone:+15550000171", "kind": "phone", "network": NSNull(), "words": "+1 555 000 0171", "from": "You added", "own": false],
         ["id": "email:person-k@example.com", "kind": "email", "network": NSNull(), "words": "person-k@example.com", "from": "Contacts", "own": false]]
    }

    private func person(_ members: [String: Any] = [:]) throws -> HomeLink.Pages.Person {
        var page = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: Self.fixtures.appendingPathComponent("person.person-b.json")))
            as? [String: Any])
        var head = try XCTUnwrap(page["head"] as? [String: Any])
        var edit = try XCTUnwrap(page["edit"] as? [String: Any])
        head.merge(["name": "Person K", "named": true, "full_name": NSNull(), "relationship": NSNull(), "entity": "person", "entity_by": NSNull()]) { $1 }
        edit.merge(["call": "Person K", "full_name": NSNull(), "name_from": NSNull(), "record": NSNull(), "details": NSNull(), "suggestions": [Any](),
                    "also_called": [Any](), "names_seen": [Any](), "joined": [Any]()]) { $1 }
        page.merge(["me": false, "became": NSNull(), "handles": Self.theirs]) { $1 }
        for (key, value) in members {
            if Self.heads.contains(key) { head[key] = value } else if Self.tops.contains(key) { page[key] = value } else { edit[key] = value }
        }
        page["head"] = head
        page["edit"] = edit
        return try JSONDecoder().decode(HomeLink.Pages.Person.self, from: JSONSerialization.data(withJSONObject: page))
    }

    private func opened(_ members: [String: Any] = [:]) throws -> PersonCard {
        PersonCard(try person(members), id: Self.id)
    }

    private func offered(_ id: String, _ kind: String, _ value: String, ticked: Bool = false, reasons: [String: Int] = [:]) -> [String: Any] {
        ["id": id, "kind": kind, "value": value, "ticked": ticked, "other": NSNull(),
         "reasons": reasons.sorted { $0.key < $1.key }.map { ["reason": $0.key, "count": $0.value] }]
    }

    private func held(work: Any = NSNull(), birthday: Any = NSNull(), profiles: [[String: String]] = []) -> [String: Any] {
        ["work": work, "birthday": birthday, "profiles": profiles, "cleared": [Any]()]
    }

    private func record(show: String) -> [String: Any] {
        ["type": "people.person", "slug": "person-k", "name": "Person K", "full_name": NSNull(), "show": show, "entity": "person",
         "relationship": NSNull(), "hidden": false, "me": false, "anchor": ["kind": "phone", "value": "+15550000171"], "handles": [Any](),
         "excluded": [Any](), "dismissed": [Any](), "also_called": [Any](), "merged_into": NSNull()]
    }

    private func row(_ id: String, _ name: String) throws -> PersonCard.Row {
        try JSONDecoder().decode(PersonCard.Row.self, from: JSONSerialization.data(withJSONObject: [
            "id": id, "name": name, "named": true, "face": false, "photo": NSNull(), "when": NSNull(), "line": NSNull(), "find": [name.lowercased()],
        ] as [String: Any]))
    }


    func testAnUntouchedCardChangedNothingAndSaysOnlyWhoItIsAbout() throws {
        let card = try opened(["relationship": "Friend from college",
                             "details": held(work: "Northside Studio", birthday: ["month": 8, "day": 14, "year": NSNull()])])
        XCTAssertEqual(card.fields, .init(name: "Person K", full: "", relationship: "Friend from college", work: "Northside Studio"))
        XCTAssertEqual(card.birthday, .init(month: 8, day: 14, year: nil))
        XCTAssertFalse(card.changed, "nothing changed: Save waits")
        XCTAssertEqual(card.answer(), HomeLink.Confirm(id: Self.id), "who it is about, and nothing else")
    }

    func testAFieldIsSentOnlyWhenItChangedAndEmptiedAsNull() throws {
        var card = try opened(["relationship": "Friend from college"])
        card.fields.name = "Kay"
        card.fields.relationship = "  "
        card.fields.full = "Person K Example "
        XCTAssertTrue(card.changed)
        let answer = card.answer()
        XCTAssertEqual(answer.name, .some("Kay"))
        XCTAssertEqual(answer.relationship, .some(nil), "emptied: null, the record says none")
        XCTAssertEqual(answer.fullName, .some("Person K Example"), "trimmed")
        XCTAssertNil(answer.details, "no detail changed")
        XCTAssertNil(answer.entity)

        card.fields = card.opened
        XCTAssertFalse(card.changed, "typed back as it opened: no change")
        XCTAssertEqual(card.answer(), HomeLink.Confirm(id: Self.id))
    }


    func testTheShownNameIsReadFromTheHomeAndRestated() throws {
        let shown = try opened(["name": "Person S", "call": "Person S", "full_name": "Person S", "record": record(show: "full_name")])
        XCTAssertEqual(shown.fields.name, "Person S", "shown by their full name: Name holds what the home calls them")
        XCTAssertEqual(shown.answer().name, .some("Person S"), "its record shows the full name: its answer restates the name shown")
        XCTAssertEqual(try opened(["call": "Sam", "full_name": "Person S"]).fields.name, "Sam")

        let number = try opened(["name": "+15550000171", "named": false, "call": NSNull()])
        XCTAssertEqual(number.fields.name, "", "the home calls them nothing: a number is no name typed")
        XCTAssertEqual(number.shownName, "+15550000171", "the head shows the number")
        var typed = number
        typed.fields.name = "Kay"
        XCTAssertEqual(typed.shownName, "Kay", "the head follows Name as typed")
        typed.fields.name = ""
        typed.fields.full = "Kay Example"
        XCTAssertEqual(typed.shownName, "Kay Example")
    }


    func testAPassiveSaveDeclinesOnlyWhatWasOfferedAsAChoice() throws {
        let card = try opened(["suggestions": [
            offered("1111111111111111", "handle", "email:person-k2@example.com"), offered("2222222222222222", "same", "person-k2"),
            offered("3333333333333333", "entity", "business"), offered("4444444444444444", "full_name", "Person K Example", ticked: true),
            offered("5555555555555555", "full_name", "Person K Other"),
        ]])
        XCTAssertEqual(card.fields.full, "Person K Example", "the full name the home ticks fills the field")
        XCTAssertTrue(card.fullFilled, "its source stands while it holds those words")
        XCTAssertFalse(card.changed, "a fill is how it opened, no change")
        let answer = card.answer()
        XCTAssertEqual(answer.accept, ["4444444444444444"])
        XCTAssertEqual(answer.decline, ["1111111111111111", "2222222222222222", "3333333333333333"],
                       "the other spelling, never offered as a choice, says nothing")
        XCTAssertTrue(answer.fullName == nil, "unchanged from what it opened with")
        XCTAssertEqual(answer.add, [], "no group, no add: the phone sends no face groups")

        var edited = card
        edited.fields.full = "Person K Exampled"
        XCTAssertFalse(edited.fullFilled, "changed: the source goes")
        XCTAssertEqual(edited.answer().accept, [], "a fill changed is neither accepted nor declined")
        XCTAssertEqual(edited.answer().fullName, .some("Person K Exampled"))

        var ticked = card
        ticked.toggle(card.offered[0])
        ticked.toggle(card.suspicions[0])
        XCTAssertEqual(ticked.answer().accept, ["1111111111111111", "3333333333333333", "4444444444444444"])
        XCTAssertEqual(ticked.answer().decline, ["2222222222222222"])
    }


    func testABirthdayIsAGuessByItsTickAndLeftUntickedSaysNothing() throws {
        let agreed = try opened(["suggestions": [offered("6666666666666666", "birthday", "1990-08-14", ticked: true,
                                                      reasons: ["cards": 1, "wished": 2])]])
        XCTAssertEqual(agreed.birthday, .init(month: 8, day: 14, year: 1990))
        XCTAssertEqual(agreed.guesses, [], "a ticked birthday is no guess")
        XCTAssertEqual(agreed.answer().accept, ["6666666666666666"])
        XCTAssertEqual(agreed.answer().details?.birthday, .some(.init(month: 8, day: 14, year: 1990)))
        var emptied = agreed
        emptied.birthday = nil
        XCTAssertEqual(emptied.answer().decline, ["6666666666666666"], "a filled birthday emptied is declined")
        XCTAssertNil(emptied.answer().details, "their details held no birthday: none changed")

        let wish = offered("7777777777777777", "birthday", "09-01", reasons: ["wished": 3])
        var guessing = try opened(["suggestions": [wish]])
        XCTAssertNil(guessing.birthday)
        XCTAssertEqual(guessing.guesses.map(\.id), ["7777777777777777"])
        XCTAssertFalse(guessing.ticked(guessing.guesses[0]), "never ticked by itself")
        XCTAssertEqual([guessing.answer().accept, guessing.answer().decline], [[], []])

        guessing.toggle(guessing.guesses[0])
        XCTAssertEqual(guessing.birthday, .init(month: 9, day: 1, year: nil))
        XCTAssertEqual(guessing.answer().accept, ["7777777777777777"])
        XCTAssertEqual(guessing.answer().details, .init(birthday: .some(.init(month: 9, day: 1, year: nil))))
        XCTAssertEqual(guessing.guesses.count, 1, "ticked, it stays under Birthday")
        guessing.toggle(guessing.guesses[0])
        XCTAssertNil(guessing.birthday)
        XCTAssertEqual([guessing.answer().accept, guessing.answer().decline], [[], []])
        XCTAssertFalse(guessing.changed)

        guessing.birthday = .init(month: 2, day: 29, year: nil)
        XCTAssertEqual(guessing.guesses, [])
        XCTAssertEqual([guessing.answer().accept, guessing.answer().decline], [[], []])
    }

    func testABirthdayValueReadsAsTheHomeSpellsIt() {
        XCTAssertEqual(PersonCard.birthday(of: "08-14"), .init(month: 8, day: 14, year: nil))
        XCTAssertEqual(PersonCard.birthday(of: "1993-08-14"), .init(month: 8, day: 14, year: 1993))
        XCTAssertEqual(PersonCard.birthday(of: "02-29"), .init(month: 2, day: 29, year: nil), "no year: February holds its 29th")
        for value in ["1993-02-29", "13-01", "8-14", "93-08-14", "08-32", "", "08-14-1993"] {
            XCTAssertNil(PersonCard.birthday(of: value), value)
        }
    }


    func testOnlyTheMembersOfTheDetailsThatChangedAreSent() throws {
        let details = held(work: "Northside Studio", profiles: [["network": "instagram", "value": "person.k"], ["network": "site", "value": "example.com/k"]])
        let card = try opened(["details": details, "suggestions": [
            offered("8888888888888888", "profile", "github:personk"), offered("9999999999999999", "profile", "x:personk"),
        ]])
        var birthday = card
        birthday.birthday = .init(month: 3, day: 4, year: 1990)
        XCTAssertEqual(birthday.answer().details, .init(birthday: .some(.init(month: 3, day: 4, year: 1990))),
                       "a birthday alone: the work saved elsewhere is not said again")
        XCTAssertEqual(birthday.answer().decline, ["8888888888888888", "9999999999999999"], "profiles offered, left unticked")

        var work = card
        work.fields.work = "  Lumen   Labs "
        XCTAssertEqual(work.answer().details, .init(work: .some("Lumen Labs")), "its spaces made one")
        work.fields.work = ""
        XCTAssertEqual(work.answer().details, .init(work: .some(nil)), "emptied: none")

        var profiles = card
        profiles.remove(card.profiles[0])
        profiles.toggle(card.offered[0])
        profiles.add(.profile(.init(network: "linkedin", value: "person-k")))
        XCTAssertEqual(profiles.profiles, [.init(network: "site", value: "example.com/k")])
        let answer = profiles.answer()
        XCTAssertEqual(answer.details, .init(profiles: [.init(network: "site", value: "example.com/k"), .init(network: "github", value: "personk"),
                                                        .init(network: "linkedin", value: "person-k")]),
                       "the list whole: those held less those taken off, then ticked, then added")
        XCTAssertEqual(answer.accept, ["8888888888888888"])
        XCTAssertEqual(answer.decline, ["9999999999999999"])
    }

    func testAWorkTheHomeTicksFillsWorkAndIsAcceptedOrDeclined() throws {
        let card = try opened(["suggestions": [offered("aaaaaaaaaaaaaaaa", "work", "Lumen Labs", ticked: true, reasons: ["cards": 2])]])
        XCTAssertEqual(card.fields.work, "Lumen Labs")
        XCTAssertTrue(card.workFilled)
        XCTAssertEqual(card.answer().accept, ["aaaaaaaaaaaaaaaa"])
        XCTAssertEqual(card.answer().details, .init(work: .some("Lumen Labs")), "kept: their details say it")
        var emptied = card
        emptied.fields.work = ""
        XCTAssertEqual(emptied.answer().decline, ["aaaaaaaaaaaaaaaa"], "emptied: declined, so it does not fill again")
        XCTAssertNil(emptied.answer().details)
    }


    func testWhatTheyAreIsSentWhenSaidAndNoSuspicionIsTicked() throws {
        var card = try opened()
        XCTAssertNil(card.said)
        card.said = "ai"
        XCTAssertEqual(card.answer().entity, "ai")

        let said = try opened(["entity": "business", "entity_by": "you"])
        XCTAssertEqual(said.said, "business", "the record's word")
        XCTAssertNil(said.answer().entity)
        var unsaid = said
        unsaid.said = nil
        XCTAssertEqual(unsaid.answer().entity, "person", "taken back: a person")

        var suspected = try opened(["suggestions": [offered("bbbbbbbbbbbbbbbb", "entity", "ai", ticked: true, reasons: ["replies": 40, "quick": 38])]])
        XCTAssertEqual(suspected.suspicions.map(\.id), ["bbbbbbbbbbbbbbbb"])
        XCTAssertEqual(suspected.answer().accept, ["bbbbbbbbbbbbbbbb"], "ticked as the home ticks it")
        suspected.said = "bot"
        XCTAssertNil(suspected.answer().entity, "a suspicion ticked says what they are")
        suspected.toggle(suspected.suspicions[0])
        XCTAssertEqual(suspected.answer().decline, ["bbbbbbbbbbbbbbbb"])
        XCTAssertEqual(suspected.answer().entity, "bot")
    }

    func testWhatTheHomeJudgedIsTheHomesUntilTheOwnerSaysOtherwise() throws {
        let judged = try opened(["entity": "business", "entity_by": "home"])
        XCTAssertEqual(judged.said, "business")
        XCTAssertTrue(judged.judged, "the home thinks so")
        XCTAssertNil(judged.answer().entity, "left as it opened: nothing said, the judgement stays the home's")
        var unsaid = judged
        unsaid.said = nil
        XCTAssertEqual(unsaid.answer().entity, "person", "× : a person, by the owner's word")
        var picked = judged
        picked.said = "bot"
        XCTAssertFalse(picked.judged, "another kind picked: the owner's")
        XCTAssertEqual(picked.answer().entity, "bot")

        XCTAssertFalse(try opened(["entity": "business", "entity_by": "you"]).judged, "the record's word: you said so")
        XCTAssertTrue(try opened(["entity": "bot"]).judged, "no one named as having said it: the home's")
        XCTAssertNil(try opened(["entity": "person"]).said, "a person: nothing said")
    }


    func testAnOwnAccountIsNeverTakenOff() throws {
        let own: [String: Any] = ["me": true, "handles": [
            ["id": "phone:+15550000171", "kind": "phone", "network": "whatsapp", "words": "+1 555 000 0171", "from": "Your WhatsApp", "own": true],
            ["id": "email:person-k@example.com", "kind": "email", "network": NSNull(), "words": "person-k@example.com", "from": "Contacts", "own": false]]]
        var card = try opened(own)
        XCTAssertTrue(card.handles[0].own)
        card.remove(card.handles[0])
        XCTAssertEqual(card.handles.count, 2, "an own account stays: it is always yours")
        XCTAssertFalse(card.changed)
        card.remove(card.handles[1])
        XCTAssertEqual(card.answer().unlink, ["email:person-k@example.com"], "the rest come off as anyone's do")
    }

    func testANumberTakenOffAndAFindAddedAreSentOnce() throws {
        let other = try row("person:person-m", "Person M")
        var card = try opened()
        card.remove(card.handles[1])
        XCTAssertEqual(card.handles.map(\.id), ["phone:+15550000171"])
        card.add(.person(other))
        card.add(.person(other))
        XCTAssertEqual(card.added.map(\.id), ["person:person-m"], "once: whom the home's find page offers, added")
        let answer = card.answer()
        XCTAssertEqual(answer.unlink, ["email:person-k@example.com"])
        XCTAssertEqual(answer.add, ["person:person-m"])
        card.drop(.person(other))
        XCTAssertEqual(card.answer().add, [])
    }


    func testACardReadAgainKeepsWhatTheOwnerDidOfWhatStillStands() throws {
        let first = try person(["suggestions": [offered("1111111111111111", "handle", "email:person-k2@example.com"),
                                                offered("2222222222222222", "same", "person-k2")]])
        var before = PersonCard(first, id: Self.id)
        before.fields.relationship = "Neighbour"
        before.birthday = .init(month: 1, day: 2, year: nil)
        before.toggle(before.offered[0])
        before.toggle(before.offered[1])
        before.remove(before.handles[1])
        before.said = "bot"
        let again = try person(["relationship": "Cousin", "suggestions": [offered("2222222222222222", "same", "person-k2")],
                                "handles": [Self.theirs[0]]])
        let card = PersonCard(again, id: Self.id, keeping: before)
        XCTAssertEqual(card.fields.relationship, "Neighbour", "what was typed")
        XCTAssertEqual(card.fields.name, "Person K")
        XCTAssertEqual(card.birthday, .init(month: 1, day: 2, year: nil), "what was picked")
        XCTAssertEqual(card.offered.map(\.id), ["2222222222222222"])
        XCTAssertTrue(card.ticked(card.offered[0]), "the tick of a suggestion still offered")
        XCTAssertEqual(card.answer().accept, ["2222222222222222"], "the one no longer offered is gone")
        XCTAssertEqual(card.answer().unlink, [], "a number no longer theirs is not taken off")
        XCTAssertEqual(card.said, "bot")
        XCTAssertEqual(card.answer().relationship, .some("Neighbour"))
    }


    private let called: [String: Any] = ["also_called": [["name": "Kay", "from": "You added"], ["name": "K.", "from": "Contacts"]]]

    func testNamesAddedAndTakenOffAreSavedAndCancelSendsNone() throws {
        var card = try opened(called)
        XCTAssertEqual(card.alsoCalled.map(\.name), ["Kay", "K."])
        XCTAssertFalse(card.changed, "opened: nothing to save, so Cancel discards nothing")
        XCTAssertEqual(card.answer(), HomeLink.Confirm(id: Self.id), "no names said while none changed")

        XCTAssertTrue(card.addName("  Big   K "), "made as the home makes it")
        card.removeName(card.alsoCalled[1])
        XCTAssertTrue(card.changed)
        XCTAssertEqual(card.alsoCalled, [.init(name: "Kay", from: "You added"), .init(name: "Big K", from: "You added")])
        var answer = card.answer()
        XCTAssertEqual(answer.addNames, ["Big K"])
        XCTAssertEqual(answer.removeNames, ["K."])

        XCTAssertTrue(card.addName("k."), "a name taken off and typed again comes back")
        card.removeName(.init(name: "Big K", from: "You added"))
        answer = card.answer()
        XCTAssertEqual(answer.addNames, [], "an added name taken off again says nothing")
        XCTAssertEqual(answer.removeNames, [])
        XCTAssertFalse(card.changed, "back as it opened")
    }

    func testANameIsMadeOnceAndTwelveAtMost() throws {
        var card = try opened(called)
        XCTAssertTrue(card.addName("KAY"), "one of theirs already, but for case: it stands")
        XCTAssertFalse(card.addName("   "), "no name")
        XCTAssertFalse(card.addName(String(repeating: "k", count: 61)), "past 60 characters")
        XCTAssertTrue(card.addName(String(repeating: "k", count: 60)))
        XCTAssertEqual(card.answer().addNames, [String(repeating: "k", count: 60)])
        for n in 1...9 { XCTAssertTrue(card.addName("Name \(n)")) }
        XCTAssertEqual(card.alsoCalled.count, PersonCard.namesAtMost)
        XCTAssertFalse(card.namesRoom, "Add a name rests at twelve")
        XCTAssertFalse(card.addName("Thirteenth"))
        XCTAssertEqual(card.answer().addNames.count, 10)
        card.removeName(card.alsoCalled[0])
        XCTAssertTrue(card.namesRoom)
    }


    private let joined: [String: Any] = ["joined": [
        ["id": "person:person-k-home", "name": "Person K Home", "photo": NSNull(), "handles": ["email:person-k@example.com"], "with": []],
        ["id": "person:person-k-old", "name": "Person K Old", "photo": NSNull(), "handles": [], "with": ["Person K School"]],
    ]]

    func testASplitTakesItsRowAndItsNumbersAndSavesInTheOrderTheyJoined() throws {
        var card = try opened(joined)
        XCTAssertEqual(card.joined.map(\.id), ["person:person-k-home", "person:person-k-old"])
        card.remove(card.handles[1])
        card.split(card.joined[1])
        card.split(card.joined[0])
        XCTAssertEqual(card.joined, [], "both rows leave")
        XCTAssertEqual(card.handles.map(\.id), ["phone:+15550000171"], "the address they brought leaves with them")
        XCTAssertTrue(card.changed)
        let answer = card.answer()
        XCTAssertEqual(answer.split, ["person:person-k-home", "person:person-k-old"], "in the order they joined")
        XCTAssertEqual(answer.unlink, [], "a number taken off that leaves with a split goes with it, not unlinked")
        XCTAssertEqual(answer.add, [])
        XCTAssertEqual(try opened(joined).answer().split, [], "Cancel: nothing split")
    }

    func testCancelThrowsAwayWhatWasStagedAndTheSheetOpenedAgainShipsOnlyItsOwn() throws {
        let read = try person(called.merging(joined) { $1 })
        var first = PersonCard(read, id: Self.id)
        first.split(first.joined[0])
        first.remove(first.handles[0])
        first.removeName(first.alsoCalled[0])
        XCTAssertEqual(first.handles, [], "the number taken off and the address leaving with the split")
        XCTAssertTrue(first.changed, "Cancel asks Discard changes?")
        var again = PersonCard(read, id: Self.id)
        XCTAssertFalse(again.changed, "opened again: nothing staged")
        XCTAssertEqual(again.joined.map(\.id), ["person:person-k-home", "person:person-k-old"], "both rows back")
        XCTAssertEqual(again.handles.map(\.id), ["phone:+15550000171", "email:person-k@example.com"], "their numbers back")
        XCTAssertEqual(again.alsoCalled.map(\.name), ["Kay", "K."])
        again.split(again.joined[1])
        XCTAssertTrue(again.addName("Kit"))
        let saved = again.answer()
        XCTAssertEqual(saved.split, ["person:person-k-old"], "only the second sheet's split")
        XCTAssertEqual(saved.unlink, [], "the number the first sheet took off stays")
        XCTAssertEqual(saved.removeNames, [], "the name the first sheet took off stays")
        XCTAssertEqual(saved.addNames, ["Kit"])
        XCTAssertEqual(again.handles.count, 2, "Person K Old brings no number: none leaves")
    }


    func testACardReadAgainKeepsTheNamesAndTheSplitsOfWhatStillStands() throws {
        var before = try opened(called.merging(joined) { $1 })
        before.addName("Kit")
        before.removeName(before.alsoCalled[1])
        before.split(before.page.edit.joined[0])
        before.split(before.page.edit.joined[1])
        before.fields.relationship = "Neighbour"
        let again = try person(called.merging(["joined": [(joined["joined"] as! [[String: Any]])[1]]]) { $1 })
        let card = PersonCard(again, id: Self.id, keeping: before)
        let answer = card.answer()
        XCTAssertEqual(answer.split, ["person:person-k-old"], "the split of someone no longer joined in is gone")
        XCTAssertEqual(answer.addNames, ["Kit"])
        XCTAssertEqual(answer.removeNames, ["K."])
        XCTAssertEqual(answer.relationship, .some("Neighbour"), "what was typed")
        XCTAssertEqual(card.handles.count, 2, "the address stands: no split takes it now")

        let named = try person(["also_called": [["name": "Kay", "from": "You added"], ["name": "Kit", "from": "You added"]]])
        let kept = PersonCard(named, id: Self.id, keeping: before).answer()
        XCTAssertEqual(kept.addNames, [], "a name added is theirs now")
        XCTAssertEqual(kept.removeNames, [], "a name taken off already is not taken off again")
    }


    func testYourCardOffersNoThisIsYou() throws {
        let card = try opened(["me": true, "suggestions": [offered("6666666666666666", "me", "me", reasons: ["whatsapp": 1])]])
        XCTAssertTrue(card.isYou)
        XCTAssertEqual(card.suspicions, [], "the home's me suspicion is gone")
    }
}
