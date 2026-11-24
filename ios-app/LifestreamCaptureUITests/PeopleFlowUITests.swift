import XCTest

@MainActor
final class PeopleFlowUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testNobodyYet() throws {
        let app = launch("--ui-test-empty-home", open: "people")
        let whatsapp = app.buttons["people.connect.whatsapp"]
        whatsapp.appears("WhatsApp, the primary")
        XCTAssertTrue(app.buttons["people.connect.imessage"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["people.view.people"].firstMatch.exists, "no views over nothing")
        keep("people-empty")

        app.openTab("Places")
        app.descendants(matching: .any)["places.empty"].firstMatch.appears("Places with nothing in it")
        XCTAssertTrue(app.buttons["places.allow"].exists, "Location, the primary step")
        XCTAssertFalse(app.buttons["places.view.trips"].exists, "no frame around nothing")
        keep("places-empty")

        app.openTab("People")
        whatsapp.tap()
        let detail = app.descendants(matching: .any)["connector.detail"].firstMatch
        detail.appears("Connect opens WhatsApp's sheet over People")
        detail.staticTexts["WhatsApp"].appears("its own sheet, once the home's streams are read")
        XCTAssertFalse(app.rootHead("Connectors").exists, "the sheet stands alone, Connectors not under it")
    }

    func testJourneyPeople() throws {
        let app = launch(open: "people")
        app.rootHead("People").appears()

        let personA = app.buttons["people.row.person:person-a"]
        personA.appears("the list reads the home's people")
        XCTAssertTrue(app.descendants(matching: .any)["people.view.people"].firstMatch.exists)
        let month = app.buttons["people.month.person:person-d"]
        XCTAssertTrue(month.exists, "This month's faces")
        XCTAssertFalse(app.buttons["people.row.phone:+15550000009"].exists, "a stranger is found by search only")
        let you = app.descendants(matching: .any)["people.you"].firstMatch
        you.appears("the list reads the home's You")
        XCTAssertLessThanOrEqual(you.frame.maxY, min(personA.frame.minY, month.frame.minY), "You first, above This month and the people")
        keep("people-list")

        you.tap()
        let name = app.staticTexts["person.name"]
        name.appears("your page")
        XCTAssertEqual(name.label, "Sam")
        keep("your-page")
        back(app)
        personA.appears()

        let personC = app.scrolledTo("people.row.person:person-c")
        until("Person C's face drawn: \(String(describing: personC.value))") { (personC.value as? String)?.hasPrefix("sha256:") == true }
        XCTAssertTrue(app.scrolledTo("people.row.email:person-f@example.com").exists, "earlier years under their year")
        keep("people-list-earlier")

        let organise = app.scrolledTo("people.tidy.organise")
        app.bringIntoView(organise, towardTop: true)
        organise.tap()
        let organising = app.descendants(matching: .any)["people.view.organise"].firstMatch
        organising.appears()
        app.buttons["people.row.phone:+15550000006"].appears("the home's Organise queue")
        XCTAssertTrue(app.buttons["people.row.email:person-f@example.com"].exists, "the same name on two networks, queued")
        XCTAssertFalse(personA.exists)
        keep("people-organise")

        app.descendants(matching: .any)["people.view.groups"].firstMatch.tap()
        let alpha = app.buttons["people.group.whatsapp:120363000000000001@g.us"]
        let beta = app.buttons["people.group.whatsapp:120363000000000002@g.us"]
        alpha.appears()
        XCTAssertTrue(beta.exists)
        XCTAssertFalse(organising.exists, "Organise's view shown only while open")
        keep("people-groups")
        alpha.tap()
        app.staticTexts["group.name"].appears()
        XCTAssertEqual(app.staticTexts["group.name"].label, "Group Alpha")
        app.descendants(matching: .any)["person.talk"].firstMatch.appears("the group's last conversation")
        keep("group-alpha")
        XCTAssertTrue(app.scrolledTo("group.writer.person:person-a").exists, "who writes most")
        back(app)
        beta.appears()
        beta.tap()
        app.staticTexts["group.name"].appears()
        XCTAssertEqual(app.staticTexts["group.name"].label, "Group Beta")
        keep("group-beta")
        back(app)
        let delta = "people.group.whatsapp:120363000000000011@g.us"
        XCTAssertFalse(app.buttons[delta].exists, "a group you are quiet in is folded")
        let fold = app.scrolledTo("people.groups.quiet")
        XCTAssertEqual(fold.value as? String, "Collapsed")
        fold.tap()
        XCTAssertTrue(app.scrolledTo(delta).exists, "opened, the quiet groups under it")
        keep("people-groups-quiet-open")
        let people = app.descendants(matching: .any)["people.view.people"].firstMatch
        app.bringIntoView(people, towardTop: true)
        people.tap()
        app.bringIntoView(personA, towardTop: true)

        let field = app.searchFields["Search people"]
        app.bringIntoView(field, towardTop: true)
        app.focus(field)
        let tip = app.buttons["Continue"]
        if tip.exists { tip.tap() }
        app.type("Stranger", into: field)
        app.buttons["people.row.phone:+15550000009"].appears()
        personA.vanishes()
        XCTAssertTrue(NSPredicate(format: "hasKeyboardFocus == true").evaluate(with: field), "the field keeps the keyboard as results land")
        keep("people-search-stranger")
        let clear = app.buttons["Clear"].firstMatch
        clear.tap()
        app.type("zzz", into: field)
        app.descendants(matching: .any)["people.search.none"].firstMatch.appears("a search that finds no one says so")
        keep("people-search-none")
        clear.tap()
        app.descendants(matching: .any)["people.view.people"].firstMatch.appears("the list back")
        XCTAssertGreaterThanOrEqual(field.frame.minY, app.rootHead("People").frame.maxY, "the list back at its top, the field showing")
        field.typeText("\n")
        app.keyboards.firstMatch.vanishes()

        app.scrolledTo("people.row.person:person-d").tap()
        name.appears()
        XCTAssertEqual(name.label, "Person D")
        app.descendants(matching: .any)["person.weeks"].firstMatch.appears("their years, from the home's page")
        keep("person-d")
        back(app)

        app.bringIntoView(personA, towardTop: true)
        personA.tap()
        name.appears()
        XCTAssertEqual(name.label, "Person A")
        let barTitle = app.staticTexts.matching(NSPredicate(format: "identifier == 'bar.title' AND label == 'Person A'")).firstMatch
        let rhythm = app.descendants(matching: .any)["person.weeks"].firstMatch
        rhythm.appears("the rhythm, once their own read lands")
        XCTAssertFalse(barTitle.exists, "the bar names them only once the head scrolls away")
        app.descendants(matching: .any)["person.talk"].firstMatch.appears("Last talked, from their newest day")
        XCTAssertTrue(app.staticTexts["person.talk.when"].label.hasSuffix("WhatsApp"), "when, then where: their one-to-one chat first")
        XCTAssertFalse(app.staticTexts["First contact"].exists, "no First contact card on a busy page")
        keep("person-a")
        let from = rhythm.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.85))
        from.drag(to: rhythm.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.85)))
        keep("person-a-scrubbed")

        let theirs = app.scrolledTo("person.photos")
        let tile = app.descendants(matching: .any)["person.photo.0"].firstMatch
        until("their newest photo drawn") { tile.value as? String == "drawn" }
        keep("person-a-photos")
        tile.tap()
        let count = app.descendants(matching: .any)["viewer.count"].firstMatch
        count.appears("the photo viewer")
        XCTAssertEqual(count.value as? String, "1 of 60", "among every photo read, from the one tapped")
        app.buttons["Close"].firstMatch.tap()
        count.vanishes("the viewer closes")
        theirs.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "View all ")).firstMatch.tap()
        let all = app.descendants(matching: .any)["person.allphotos"].firstMatch
        all.appears("every photo of theirs")
        all.descendants(matching: .any)["person.photo.0"].firstMatch.appears()
        let second = all.descendants(matching: .any)["person.photo.60"].firstMatch
        app.bringIntoView(second)
        XCTAssertTrue(second.exists, "the second page was read")
        back(app)

        app.drag(up: true)
        barTitle.appears("scrolled, the bar names them")
        keep("person-a-talk")
        XCTAssertTrue(app.scrolledTo("person.calls").exists, "their calls of 30 days, one row")
        XCTAssertTrue(app.scrolledTo("person.chat.whatsapp:120363000000000003@g.us").exists, "where you talk")
        let rest = "person.chat.whatsapp:120363000000000011@g.us"
        XCTAssertFalse(app.descendants(matching: .any)[rest].firstMatch.exists, "a quiet group folded")
        app.scrolledTo("person.chats.more").tap()
        let quiet = app.scrolledTo(rest)
        XCTAssertTrue(quiet.label.contains("Quiet"), "a quiet group marked: \(quiet.label)")
        keep("person-a-where")
        let open = app.buttons["person.talk.open"].firstMatch
        app.bringIntoView(open, towardTop: true)
        open.tap()
        app.descendants(matching: .any)["days.day"].firstMatch.appears("Open the day")
        XCTAssertTrue(app.tab("People").isSelected, "on People's own stack")
    }

    func testAPhotoChosenInDark() throws {
        let app = launch("--ui-test-picked-photo", open: "people")
        let personA = app.buttons["people.row.person:person-a"]
        personA.appears()
        XCTAssertEqual(personA.value as? String, "monogram", "no photo yet: the row's face is the monogram")
        personA.tap()

        app.descendants(matching: .any)["page.fact.birthday"].firstMatch.appears("their own read brings their details")
        let instagram = app.descendants(matching: .any)["page.fact.instagram:@person.a"].firstMatch
        XCTAssertTrue(instagram.exists)
        XCTAssertEqual(instagram.elementType, .link, "a profile is a link")
        keep("person-head-chips")

        let face = openEdit(app)
        XCTAssertEqual(face.value as? String, "monogram")
        keep("person-photo-before")
        face.tap()
        let theirs = app.buttons["person.face.theirs"], library = app.buttons["person.face.library"]
        theirs.appears("they have photos of their own")
        XCTAssertTrue(library.exists)
        keep("person-face-menu")

        theirs.tap()
        app.navigationBars["Their Photos"].appears()
        let pager = app.descendants(matching: .any)["person.photos.pager"].firstMatch
        pager.appears("more than one page")
        XCTAssertEqual(pager.value as? String, "1 of 3", "70 photos, three pages, as the home counts them")
        let tile = { (index: Int) in app.descendants(matching: .any)["person.photos.\(index)"].firstMatch }
        XCTAssertTrue(tile(0).exists, "the newest first")
        until("photo 0 drawn") { tile(0).value as? String == "drawn" }
        keep("person-their-photos")
        app.bringIntoView(tile(23), and: pager)
        XCTAssertFalse(tile(24).exists, "24 a page, the last of them in view")
        pager.stepUp()
        XCTAssertEqual(pager.value as? String, "2 of 3")
        tile(24).appears("the next page, from its top")
        XCTAssertFalse(tile(0).exists)
        pager.stepUp()
        XCTAssertEqual(pager.value as? String, "3 of 3")
        tile(48).appears("the last page")
        app.bringIntoView(tile(69), and: pager)
        pager.stepDown()
        XCTAssertEqual(pager.value as? String, "2 of 3")
        tile(24).appears("back on the second page")

        tile(24).tap()
        let title = app.staticTexts["Move and Scale"]
        title.appears("Move and Scale over the whole photo")
        keep("person-their-photo-move")
        app.buttons["Choose"].tap()
        title.vanishes()
        let fromTheirs = face.value as? String ?? ""
        XCTAssertTrue(fromTheirs.hasPrefix("sha256:"), "Edit's face shows the square at once: \(fromTheirs)")
        closeEdit(app)
        let taken = app.staticTexts["ui-test.people.taken"]
        until("one action, a photo: \(taken.label)") { taken.label == "1 1" }
        XCTAssertEqual(app.staticTexts["ui-test.people.image"].label, fromTheirs, "the square the face drew")

        openEdit(app).tap()
        library.appears("the face's menu")
        library.tap()
        title.appears("Move and Scale over the picture handed over")
        let stage = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Picture'")).firstMatch
        XCTAssertTrue(stage.exists)
        XCTAssertTrue(app.buttons["Cancel"].exists)
        keep("person-photo-move")
        stage.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .drag(to: stage.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.56)), velocity: .slow, hold: 0.1)
        stage.pinch(withScale: 1.3, velocity: 1)
        keep("person-photo-scaled")
        app.buttons["Choose"].tap()
        title.vanishes()
        let chosen = face.value as? String ?? ""
        XCTAssertTrue(chosen.hasPrefix("sha256:") && chosen != fromTheirs, "Edit's face shows the new square at once: \(chosen)")
        closeEdit(app)
        until("another action, a photo: \(taken.label)") { taken.label == "2 2" }
        XCTAssertEqual(app.staticTexts["ui-test.people.image"].label, chosen, "the square the face draws")
        let done = app.staticTexts["page.done"]
        done.appears("the head says what the photo came to")
        XCTAssertTrue(done.label.hasPrefix("Photo saved"))
        XCTAssertTrue(app.buttons["page.undo"].exists, "its Undo")
        keep("person-photo-saved")

        back(app)
        personA.appears()
        until("the row draws the home's answer of the square: \(personA.value as? String ?? "")") { personA.value as? String == chosen }
        keep("people-row-photo")
        personA.tap()
        done.appears("the newest act's line stands on its person's page, as the book keeps it")
        XCTAssertTrue(done.label.hasPrefix("Photo saved"), done.label)
        XCTAssertTrue(app.buttons["page.undo"].exists, "Undo on the newest act, after the page was left")
        XCTAssertEqual(openEdit(app).value as? String, chosen, "the home's answer of the same square, drawn as it opens")
        XCTAssertEqual(taken.label, "2 2", "never sent again")
        keep("person-photo-landed")
    }

    func testEditInDark() throws {
        let app = launch(open: "stream:whatsapp")
        app.descendants(matching: .any)["connector.detail"].firstMatch.appears("WhatsApp's page")
        app.expandSheet()
        app.scrolledTo("connector.detail.quiet").tap()
        app.rootHead("People").appears("People's Groups view")
        let delta = app.scrolledTo("people.group.whatsapp:120363000000000011@g.us")
        XCTAssertTrue(delta.exists, "the quiet ones open")
        keep("whatsapp-quiet-groups")

        delta.tap()
        let group = app.staticTexts["group.name"]
        group.appears()
        XCTAssertEqual(group.label, "Group Delta")
        let choice = app.scrolledTo("group.quiet.choice")
        XCTAssertEqual(choice.value as? String, "Follow the rule")
        keep("group-quiet-why")
        choice.tap()
        let always = app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Always quiet'")).firstMatch
        always.appears("the three-way choice")
        always.tap()
        let taken = app.staticTexts["ui-test.people.taken"]
        until("one action, the group's word: \(taken.label)") { taken.label == "1 0" }
        until("drawn at once: \(String(describing: choice.value))") { choice.value as? String == "Always quiet" }
        app.staticTexts["You set it"].appears("why, once People holds it")
        keep("group-quiet-set")
        back(app)

        let people = app.descendants(matching: .any)["people.view.people"].firstMatch
        app.bringIntoView(people, towardTop: true)
        people.tap()
        let personA = app.buttons["people.row.person:person-a"]
        app.bringIntoView(personA, towardTop: true)
        personA.tap()
        let edit = app.buttons["person.edit.open"]
        edit.appears("Edit, the page's one action, once their own read has landed")
        edit.tap()

        let sheet = app.descendants(matching: .any)["person.edit"].firstMatch
        sheet.appears()
        let save = app.buttons["person.edit.save"]
        XCTAssertFalse(save.isEnabled, "nothing changed: Save waits")
        let name = app.textFields["Name"]
        XCTAssertEqual(name.value as? String, "Person A")
        app.staticTexts.matching(NSPredicate(format: "label == %@", "WhatsApp · 4\u{00A0}mails")).firstMatch
            .appears("where it was seen, at the field's end, heard whole however much is drawn")
        keep("person-edit")

        typeAtEnd(app, name, deleting: "Person A".count, "Ace")
        XCTAssertTrue(save.isEnabled, "something changed: Save is offered")
        let relationship = app.textFields["Relationship"]
        typeAtEnd(app, relationship, deleting: "college".count, "school")
        XCTAssertEqual(relationship.value as? String, "Friend from school")

        let birthday = app.buttons["Birthday"]
        birthday.tap()
        app.buttons["Clear birthday"].appears("the wheel open, Clear under it")
        app.buttons["Clear birthday"].tap()
        until("cleared: \(String(describing: birthday.value))") { birthday.value as? String == "Add birthday" }
        birthday.tap()
        XCTAssertNotEqual(birthday.value as? String, "Add birthday", "opened with none, the wheel starts at today, the row saying it")
        let picked = birthday.value as? String ?? ""
        XCTAssertEqual(picked.split(separator: " ").count, 2, "a day and a month, no year: \(picked)")
        birthday.tap()

        let add = app.textFields["person.edit.add"]
        app.bringIntoView(add)
        app.type("@person.a.photos", into: add)
        let instagram = app.descendants(matching: .any)["person.edit.find.profile:instagram:person.a.photos"].firstMatch
        instagram.appears("the handle as Instagram's")
        XCTAssertTrue(app.descendants(matching: .any)["person.edit.find.profile:x:person.a.photos"].firstMatch.exists, "and as X's")
        instagram.tap()
        app.descendants(matching: .any)["person.edit.added.profile:instagram:person.a.photos"].firstMatch.appears("added, ticked")
        keep("person-edit-added")

        let address = app.descendants(matching: .any)["person.edit.handle.email:person-a.home@example.com"].firstMatch
        app.bringIntoView(address, towardTop: true)
        address.swipeLeft()
        app.buttons["Remove"].firstMatch.tap()
        address.vanishes("taken off Numbers and emails")
        keep("person-edit-changed")

        save.tap()
        sheet.vanishes("a 200 closes the sheet")
        let head = app.staticTexts["person.name"]
        XCTAssertEqual(head.label, "Ace", "the sheet's name, at once")
        let said = app.staticTexts["ui-test.people.said"]
        until("the confirmation the sheet sent: \(said.label)") { said.label.contains("\"id\":\"person:person-a\"") }
        var sent = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(said.label.utf8)) as? [String: Any], said.label)
        var details = try XCTUnwrap(sent["details"] as? [String: Any], said.label)
        XCTAssertNotNil(details.removeValue(forKey: "birthday") as? [String: Any], "the birthday picked: \(said.label)")
        sent["details"] = details
        XCTAssertEqual(sent as NSDictionary, [
            "of": "people", "id": "person:person-a", "accept": ["f39e76582d050fa2"], "name": "Ace", "relationship": "Friend from school",
            "unlink": ["email:person-a.home@example.com"],
            "details": ["profiles": [
                ["network": "instagram", "value": "person.a"], ["network": "site", "value": "example.com/person-a"],
                ["network": "instagram", "value": "person.a.photos"],
            ]],
        ] as NSDictionary, "the sheet sent what was typed, added and removed, before the saved page is drawn: \(said.label)")
        let done = app.staticTexts["page.done"]
        done.appears()
        XCTAssertTrue(done.label.hasPrefix("Saved"))
        let undo = app.buttons["page.undo"]
        XCTAssertTrue(undo.exists)
        until("one action more: \(taken.label)") { taken.label == "2 0" }
        XCTAssertTrue(app.descendants(matching: .any)["page.fact.instagram:@person.a.photos"].firstMatch.exists, "the profile among the chips")
        keep("person-edit-saved")

        undo.tap()
        until("Undo draws them as before: \(head.label)") { head.label == "Person A" }
        done.vanishes("the line's Undo is spent")
        until("the canned writer took the undo: \(taken.label)") { taken.label == "3 0" }
        XCTAssertEqual(app.descendants(matching: .any)["page.line"].firstMatch.label, "Friend from college")
        keep("person-edit-undone")
    }


    private func typeAtEnd(_ app: XCUIApplication, _ field: XCUIElement, deleting: Int, _ text: String) {
        app.focus(field, fromEnd: true)
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: deleting) + text)
    }

    private func back(_ app: XCUIApplication) {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    private func openEdit(_ app: XCUIApplication) -> XCUIElement {
        let edit = app.buttons["person.edit.open"]
        edit.appears("Edit, the page's one action, once their own read has landed")
        edit.tap()
        let face = app.buttons["person.face"]
        face.appears("the home names this phone a people source: Edit's face takes a tap")
        return face
    }

    private func closeEdit(_ app: XCUIApplication) {
        let sheet = app.descendants(matching: .any)["person.edit"].firstMatch
        app.buttons["person.edit.cancel"].tap()
        sheet.vanishes("Cancel with nothing changed closes Edit")
    }
}
