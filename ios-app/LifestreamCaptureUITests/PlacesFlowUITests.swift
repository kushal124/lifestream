import XCTest

@MainActor
final class PlacesFlowUITests: XCTestCase {
    func testJourneyTheListNamingCitiesAndTrips() throws {
        continueAfterFailure = false
        let app = launch()
        let townName = try Self.city(holding: "home-place"), awayName = try Self.city(holding: "harbour-inn")
        let summaries = ["where.day", "where.month", "where.year", "year"]
        let listed = app.asks("places"), summed = summaries.map { app.asks($0) }
        app.openPlaces()

        XCTAssertTrue(app.descendants(matching: .any)["places.map"].firstMatch.exists, "the map fills the page")
        let invite = app.buttons["places.invite"]
        invite.appears("the home asks about spots")
        XCTAssertEqual(invite.label, "3 places to name")
        app.row("places.row.home-place").appears("the home's own places under their city")
        XCTAssertEqual(app.asks("places"), listed + 1, "Places' open reads the list, once")
        XCTAssertEqual(summaries.map { app.asks($0) }, summed, "Places' open asks no day, month or year of where, and no year page")
        let map = app.descendants(matching: .any)["places.map"].firstMatch
        map.apart("The Office", "Home", "the map fits the first city, its places apart")
        keep("list")

        app.raiseSheet()
        XCTAssertFalse(app.row("places.row.corner-bakery").exists, "a place visited once is folded")
        let once = app.scrolledTo("places.once.\(townName)")
        XCTAssertEqual(once.label, "Visited once, 1")
        once.tap()
        app.navigationBars["Visited once"].appears("Visited once opens its page")
        let bakery = app.row("places.row.corner-bakery")
        bakery.appears("the place visited once, on its page")
        bakery.tap()
        let title = app.staticTexts["page.title"]
        title.appears()
        XCTAssertEqual(title.label, "Corner Bakery")
        app.descendants(matching: .any)["place.photos"].firstMatch.appears("its photos")
        XCTAssertTrue(app.scrolledTo("place.visit.0").exists, "its one visit")
        XCTAssertFalse(app.staticTexts["place.rhythm"].exists, "one day has no rhythm")
        XCTAssertFalse(app.descendants(matching: .any)["place.visit.1"].firstMatch.exists)
        keep("page-once")
        app.openPlaces()
        app.lowerSheet()

        let read = (day: app.asks("day"), where: app.asks("where"))
        invite.tap()
        let position = app.descendants(matching: .any)["naming.position"].firstMatch
        position.appears("the invitation opens the first spot")
        XCTAssertTrue(position.label.hasSuffix("1 of 3"), position.label)
        let name = app.buttons["naming.name.0"]
        name.appears("the home's names for its stay")
        XCTAssertTrue(name.label.hasPrefix("Synthetic Gym, Calendar · "), name.label)
        let field = app.namingField, witnessed = app.descendants(matching: .any)["naming.witnessed"].firstMatch
        XCTAssertLessThan(field.frame.maxY, name.frame.minY, "the task first: the field, the rows under it")
        XCTAssertLessThan(name.frame.maxY, witnessed.frame.minY, "then what witnessed it")
        XCTAssertLessThan(witnessed.frame.maxY, app.staticTexts["naming.more"].frame.minY, "then the photos, how many more under them")
        XCTAssertEqual(app.asks("day"), read.day, "no day file read for a card")
        XCTAssertEqual(app.asks("where"), read.where, "and no where")
        app.descendants(matching: .any)["naming.map"].firstMatch.showsGround("the map's ground, past its first render")
        keep("naming")

        let takes = app.staticTexts["naming.takes"]
        takes.appears("what the circle takes in, under the map")
        let size = app.descendants(matching: .any)["circle.size"].firstMatch
        let center = app.descendants(matching: .any)["circle.center"].firstMatch
        let namingMap = app.descendants(matching: .any)["naming.map"].firstMatch
        let namingReach = app.descendants(matching: .any)["naming.reach"].firstMatch
        XCTAssertEqual(size.value as? String, "80\u{00A0}m")
        XCTAssertEqual(center.value as? String, "Where it was")
        XCTAssertEqual(namingReach.value as? String, "80\u{00A0}m", "the stepper beside the line")
        namingReach.stepUp()
        XCTAssertEqual(size.value as? String, "85\u{00A0}m", "the handle follows the stepper")
        namingReach.stepDown()
        XCTAssertEqual(size.value as? String, "80\u{00A0}m")
        let from = namingMap.coordinate(withNormalizedOffset: CGVector(dx: 0.45, dy: 0.85))
        from.drag(to: from.withOffset(CGVector(dx: -70, dy: 0)), hold: 0.2)
        until("the centre moves east: \(String(describing: center.value))") { (center.value as? String)?.hasSuffix(" east") == true }
        XCTAssertTrue(position.label.hasSuffix("1 of 3"), "a drag on the map is no Skip: \(position.label)")
        XCTAssertFalse(takes.label.contains("overlaps"), "the circle as it opened clears The Office: \(takes.label)")
        for _ in 0..<3 where !takes.label.contains("overlaps The Office") {
            let knob = size.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            knob.drag(to: namingMap.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5)), hold: 0.2)
        }
        XCTAssertTrue(takes.label.hasSuffix("overlaps The Office"), takes.label)
        let grown = try XCTUnwrap(metres(size.value as? String), "\(String(describing: size.value))")
        XCTAssertGreaterThan(grown, 80, "the handle grew the circle until it reached The Office")
        XCTAssertEqual(namingReach.value as? String, size.value as? String, "the stepper follows the handle")
        keep("naming-circle")

        app.type("Synth", into: field)
        app.buttons["name.save"].appears("Save, once a name is typed")
        let google = app.buttons["naming.name.2"]
        until("Google's name typed for, with no distance: \(google.label)") { google.label == "Synth Commons, Google" }
        XCTAssertTrue(name.label.hasPrefix("Synthetic Gym, "), "the name holding the words stays: \(name.label)")
        XCTAssertTrue(app.buttons["naming.name.1"].label.hasPrefix("Synthetic Station, "), app.buttons["naming.name.1"].label)
        XCTAssertFalse(app.buttons["naming.name.3"].exists, "the names without them go")
        XCTAssertFalse(app.descendants(matching: .any)["naming.name.credit"].firstMatch.exists,
                       "each of Google's names says so on its own row: no credit under them all")
        keep("naming-typed")

        name.tap()
        until("the second spot: \(position.label)") { position.label.hasSuffix("2 of 3") }
        let named = try XCTUnwrap(stated(app, "the place named") { $0["kind"] as? String == "create" && $0["name"] as? String == "Synthetic Gym" })
        XCTAssertNil(named["slug"], "the home mints the slug")
        XCTAssertEqual(named["radius_m"] as? Double, grown, "the circle as set")
        XCTAssertGreaterThan(try XCTUnwrap(named["longitude"] as? Double), -122.0090, "east of the spot's centre")

        XCTAssertTrue(app.descendants(matching: .any)["naming.home"].firstMatch.exists, "the home asks Is this home? of this spot")
        keep("naming-home")
        app.buttons["naming.home.no"].tap()
        app.type("Office", into: app.namingField)
        until("one of your places, typed for: \(name.label)") { name.label.hasPrefix("The Office, ") }
        keep("naming-own")
        name.tap()
        until("the third spot: \(position.label)") { position.label.hasSuffix("3 of 3") }
        let added = app.staticTexts["naming.added"]
        added.appears("the next card says what was added")
        XCTAssertTrue(added.label.hasSuffix("The Office"), added.label)
        let office = try XCTUnwrap(stated(app, "the circle added") { $0["kind"] as? String == "add-circle" && $0["slug"] as? String == "the-office" })
        XCTAssertEqual(Set(office.keys), ["of", "kind", "request", "slug", "latitude", "longitude", "radius_m"],
                       "the spot's circle alone: its name, first circle and the spot's No are not The Office's to restate")
        keep("naming-added")

        app.buttons["naming.undo"].tap()
        added.vanishes("undone")
        stated(app, "restated without the circle") { $0["slug"] as? String == "the-office" && Self.also($0)?.isEmpty == true }
        app.buttons["naming.hide"].tap()
        let finish = app.staticTexts["naming.finish"]
        finish.appears("the finish")
        XCTAssertEqual(finish.label, "1 place named")
        XCTAssertTrue(app.staticTexts["Synthetic Gym"].exists, "the place named, by name")
        keep("naming-finish")
        app.buttons["naming.done"].tap()
        until("the one undone is still to name, the one hidden is not: \(invite.exists ? invite.label : "no invitation")") {
            invite.exists && invite.label == "1 place to name"
        }
        let newPlace = app.row("places.row.synthetic-gym-")
        newPlace.appears("a new place mints its id from its name and shows at once")
        XCTAssertTrue(newPlace.label.contains("You're here"), "the phone sits at it: \(newPlace.label)")

        app.raiseSheet()
        let hidden = app.scrolledTo("places.hidden")
        XCTAssertTrue(hidden.label.contains("3"), "the home's two and the one just hidden: \(hidden.label)")
        keep("named")
        hidden.tap()
        app.navigationBars["Hidden spots"].appears("its name in the bar")
        app.descendants(matching: .any)["hidden.known.hidden-c0ffee"].firstMatch.appears("the spot's row")
        keep("hidden")
        app.buttons["hidden.unhide.hidden-c0ffee"].tap()
        app.descendants(matching: .any)["hidden.spot.hidden-c0ffee"].firstMatch.vanishes("unhidden")
        XCTAssertTrue(app.descendants(matching: .any)["hidden.spot.hidden-0a0b0c"].firstMatch.exists, "the other stays hidden")
        app.navigationBars.buttons.firstMatch.tap()
        app.lowerSheet()
        XCTAssertEqual(invite.label, "1 place to name", "no spot made up where the hidden one was")

        app.buttons["places.view.cities"].tap()
        let town = app.buttons["places.city.\(townName)"]
        town.appears()
        let other = app.buttons["places.city.\(awayName)"]
        XCTAssertTrue(other.exists)
        XCTAssertLessThan(town.frame.minY, other.frame.minY, "the city of the newest visit first")
        keep("cities")
        other.tap()
        app.staticTexts["places.city.title"].appears()
        XCTAssertEqual(app.staticTexts["places.city.title"].label, awayName)
        XCTAssertTrue(app.staticTexts["places.city.line"].label.hasPrefix("1\u{00A0}place · since "), app.staticTexts["places.city.line"].label)
        XCTAssertFalse(app.buttons["places.once.\(awayName)"].exists)
        app.row("places.row.harbour-inn").appears("its place visited once")
        keep("city")
        app.buttons["places.city.back"].tap()
        town.appears("back to the cities")

        app.buttons["places.view.places"].tap()
        let heading = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(townName), ")).firstMatch
        heading.appears()
        heading.tap()
        XCTAssertEqual(app.staticTexts["places.city.title"].label, townName)
        app.buttons["places.city.back"].tap()
        app.buttons["places.view.places"].tap()

        let years = (asked: app.asks("year"), tagged: app.asks("year.tagged"))
        let away = try Self.trip(in: tripYear)
        app.buttons["places.view.trips"].tap()
        let year = app.descendants(matching: .any)["places.year"].firstMatch
        year.appears()
        app.descendants(matching: .any)["places.trips.figures"].firstMatch.appears("the year landed")
        XCTAssertEqual(app.asks("year"), years.asked + 1, "Trips reads its year, once")
        XCTAssertEqual(app.asks("year.tagged"), years.tagged, "the first read of a year holds no tag")
        let thisYear = String(Calendar(identifier: .gregorian).component(.year, from: TestClock.now))
        let shownYear = { year.value as? String ?? "" }
        XCTAssertEqual(shownYear(), thisYear)
        let pick = { (chosen: Int) in
            year.tap()
            let item = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND identifier != 'places.year'", String(chosen))).firstMatch
            item.appears("\(chosen) in the menu")
            item.tap()
            until("the year \(chosen) chosen: \(shownYear())") { shownYear() == String(chosen) }
        }
        if shownYear() != String(tripYear) { pick(tripYear) }
        let trip = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "places.trip.")).firstMatch
        trip.appears("last month's trip")
        XCTAssertTrue(trip.label.contains(away.title), trip.label)
        app.raiseSheet()
        keep("trips")
        pick(tripYear - 1)
        app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "No nights away")).firstMatch.appears("the year before holds no trip")
        pick(tripYear)
        trip.appears()

        app.bringIntoView(trip)
        trip.tap()
        title.appears()
        XCTAssertEqual(title.label, away.title)
        let night = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "trip.day.", away.city))
            .firstMatch
        night.appears("a night in \(away.city)")
        keep("trip")
        app.navigationBars.buttons.firstMatch.tap()

        app.relaunch("--ui-test-home-held", open: "places")
        app.row("places.row.home-place").appears("the list kept from the last read, drawn while the home is held")
        app.descendants(matching: .any)["page.note"].firstMatch.appears("the kept list says why it is not fresh, as People's pages do")
        keep("held-kept")
    }

    func testJourneyAPlacesPageAndItsEdit() throws {
        continueAfterFailure = false
        let app = launch()
        app.openPlaces()
        let title = app.staticTexts["page.title"]
        let size = app.descendants(matching: .any)["circle.size"].firstMatch
        let center = app.descendants(matching: .any)["circle.center"].firstMatch

        let asked = (place: app.asks("place"), tagged: app.asks("place.tagged"))
        let theOffice = app.row("places.row.the-office")
        theOffice.appears()
        app.raiseSheet()
        theOffice.tap()
        title.appears()
        XCTAssertEqual(title.label, "The Office")
        XCTAssertEqual(app.staticTexts["page.line"].label, try Self.city(of: "the-office"))
        app.descendants(matching: .any)["place.map"].firstMatch.appears("its map")
        app.staticTexts["place.rhythm"].appears("its rhythm")
        XCTAssertEqual(app.asks("place"), asked.place + 1)
        XCTAssertEqual(app.asks("place.tagged"), asked.tagged, "the first ask holds no tag")
        XCTAssertFalse(app.descendants(matching: .any)["place.home"].firstMatch.exists, "nothing asked of The Office")
        keep("place")
        let tile = app.scrolledTo("place.photo.0")
        until("its first photo drawn, from its tile's picture") { tile.exists && tile.value as? String == "drawn" }
        XCTAssertTrue(app.scrolledTo("place.person.person:person-a").exists, "Person A, there on Tuesdays and Thursdays")
        XCTAssertTrue(app.scrolledTo("place.visit.0").exists, "its newest visit")
        XCTAssertTrue(app.scrolledTo("place.visits.all").exists, "more visits than the page shows")
        keep("place-visits")
        app.navigationBars.buttons.firstMatch.tap()
        theOffice.appears()
        theOffice.tap()
        app.asks("place", reach: asked.place + 2)
        XCTAssertEqual(app.asks("place.tagged"), asked.tagged + 1, "opened again, it asks with If-None-Match")

        let edit = app.buttons["place.edit"]
        edit.appears()
        edit.tap()
        let reach = app.descendants(matching: .any)["places.sheet.reach"].firstMatch
        reach.appears()
        XCTAssertEqual(reach.value as? String, "90\u{00A0}m")
        XCTAssertEqual(size.value as? String, "90\u{00A0}m", "the circle the place has")
        XCTAssertEqual(center.value as? String, "Where it was")
        let only = app.descendants(matching: .any)["places.sheet.circle.0"].firstMatch
        XCTAssertTrue(only.isSelected && only.label.hasPrefix("Circle, Takes in "), only.label)
        XCTAssertFalse(app.buttons["places.sheet.circle.0.remove"].exists, "the one circle is never removed")
        XCTAssertTrue(app.buttons["places.sheet.circle.add"].isEnabled, "Add circle under it")
        reach.stepDown()
        XCTAssertEqual(reach.value as? String, "85\u{00A0}m", "a notch down the ladder")
        reach.stepUp()
        XCTAssertEqual(reach.value as? String, "90\u{00A0}m", "and a step back up")
        reach.stepUp()
        XCTAssertEqual(size.value as? String, "95\u{00A0}m", "the handle follows the stepper")
        reach.stepUp()
        XCTAssertEqual(size.value as? String, "100\u{00A0}m")
        keep("edit")
        let knob = size.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        knob.drag(to: knob.withOffset(CGVector(dx: 40, dy: 0)), hold: 0.2)
        let ring = try XCTUnwrap(metres(size.value as? String), "\(String(describing: size.value))")
        XCTAssertGreaterThan(ring, 100, "the handle dragged outward grows the ring")
        XCTAssertEqual(reach.value as? String, size.value as? String, "one value")
        let sheetMap = app.descendants(matching: .any)["places.sheet.map"].firstMatch
        let pan = sheetMap.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.8))
        pan.drag(to: pan.withOffset(CGVector(dx: 90, dy: 0)), hold: 0.2)
        until("the centre moves west: \(String(describing: center.value))") { (center.value as? String)?.hasSuffix(" west") == true }
        XCTAssertEqual(size.value as? String, reach.value as? String, "a pan leaves the size alone")
        keep("edit-moved")

        let placeName = app.textFields["places.sheet.name"]
        app.focus(placeName, fromEnd: true)
        placeName.typeText(" Annex")
        let cancel = app.buttons["places.sheet.cancel"]
        let top = app.navigationBars.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        top.drag(to: top.withOffset(CGVector(dx: 0, dy: 600)))
        XCTAssertTrue(cancel.exists, "the edit is kept on screen: the sheet springs back")
        app.buttons["places.sheet.save"].tap()
        until("the page named anew: \(title.label)") { title.label == "The Office Annex" }
        let annex = try XCTUnwrap(stated(app, "the edit kept") { $0["kind"] as? String == "edit" && $0["slug"] as? String == "the-office"
            && $0["radius_m"] as? Double == ring })
        XCTAssertEqual(annex["name"] as? String, "The Office Annex")
        XCTAssertNil(annex["also"], "no other circle changed")
        XCTAssertLessThan(try XCTUnwrap(annex["longitude"] as? Double), -122.0010, "moved west of where it was")
        edit.tap()
        reach.appears()
        XCTAssertEqual(metres(reach.value as? String), ring, "Edit opens on the new circle")
        XCTAssertEqual(center.value as? String, "Where it was", "its new centre")
        cancel.tap()
        cancel.vanishes()

        app.openPlace("places.row.home-place")
        let question = app.descendants(matching: .any)["place.home"].firstMatch
        question.appears("the home asks of Home")
        keep("page-home")
        app.buttons["Yes, it’s home"].tap()
        question.vanishes("answered, it goes")
        app.scrolledTo("place.visit.0").tap()
        app.capturePlus.appears("a visit opens its day")
        app.openPlace("places.row.home-place")
        app.staticTexts["place.rhythm"].appears()
        XCTAssertFalse(question.exists, "and stays gone while the home derives the answer")

        app.openPlace("places.row.willow-court")
        edit.tap()
        let row = { (index: Int) in app.descendants(matching: .any)["places.sheet.circle.\(index)"].firstMatch }
        row(2).appears("the Circles card, a row per circle")
        XCTAssertFalse(app.staticTexts["places.sheet.takes"].exists, "what a circle takes in is said in its row alone")
        XCTAssertTrue(row(0).isSelected, "the first circle selected at open")
        XCTAssertEqual(reach.value as? String, "55\u{00A0}m", "the selected row's stepper")
        keep("edit-three-circles")

        let perPoint = 55 / (size.frame.midX - center.frame.midX)
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: center.frame.midX - 35 / perPoint, dy: center.frame.midY + 65 / perPoint)).tap()
        until("a tap inside C selects it") { row(2).isSelected }
        XCTAssertEqual(reach.value as? String, "80\u{00A0}m", "the stepper moves to the circle selected")
        app.bringIntoView(row(1))
        row(1).tap()
        until("the row selects B") { row(1).isSelected }
        XCTAssertEqual(reach.value as? String, "30\u{00A0}m")
        reach.stepUp()
        until("B a notch larger: \(String(describing: reach.value))") { reach.value as? String == "35\u{00A0}m" }
        XCTAssertTrue(row(1).label.hasSuffix("Takes in 2\u{00A0}stays"), "the place's two afternoons, before a circle on the pin: \(row(1).label)")

        let add = app.buttons["places.sheet.circle.add"], bar = app.navigationBars.firstMatch
        let typing = NSPredicate(format: "hasKeyboardFocus == true")
        app.bringIntoView(app.buttons["places.sheet.remove"])
        app.bringIntoView(placeName)
        app.focus(placeName)
        XCTAssertLessThan(sheetMap.frame.minY, bar.frame.maxY, "the map scrolled up out of view")
        add.tap()
        row(3).appears("a fourth row")
        until("the circle added selected, the keyboard let go, the map in view: \(sheetMap.frame)") {
            row(3).isSelected && !typing.evaluate(with: placeName) && sheetMap.frame.minY >= bar.frame.maxY - 8
        }
        XCTAssertTrue(row(3).label.hasSuffix("Takes in 4\u{00A0}stays"), "the pin on the spot: its two stays join the place's two: \(row(3).label)")
        XCTAssertEqual(reach.value as? String, "35\u{00A0}m", "B's reach")
        XCTAssertEqual(center.value as? String, "Where it was")
        keep("edit-circle-added")
        let moving = sheetMap.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.8))
        moving.drag(to: moving.withOffset(CGVector(dx: 90, dy: 0)), hold: 0.2)
        until("the circle added moves west: \(String(describing: center.value))") { (center.value as? String)?.hasSuffix(" west") == true }
        let removeA = app.buttons["places.sheet.circle.0.remove"]
        app.bringIntoView(removeA)
        removeA.tap()
        row(3).vanishes("A removed")
        until("the circle added still selected, now the third") { row(2).isSelected }
        XCTAssertTrue(row(0).label.hasPrefix("Circle 1, 35\u{00A0}m, "), "B the first: \(row(0).label)")

        app.buttons["places.sheet.save"].tap()
        let statement = try XCTUnwrap(stated(app, "the circles as they stand") { $0["slug"] as? String == "willow-court" })
        XCTAssertNil(statement["name"], "the name, unchanged, is not restated")
        XCTAssertEqual(statement["radius_m"] as? Double, 35)
        XCTAssertEqual(try XCTUnwrap(statement["latitude"] as? Double), 37.3420, accuracy: 1e-6, "B, the first")
        XCTAssertEqual(try XCTUnwrap(statement["longitude"] as? Double), -122.01626, accuracy: 1e-6, "B, the first")
        let also = try XCTUnwrap(Self.also(statement))
        XCTAssertEqual(also.count, 2, "C and the circle added")
        XCTAssertEqual(also[0]["radius_m"] as? Double, 80)
        XCTAssertEqual(try XCTUnwrap(also[0]["latitude"] as? Double), 37.34097, accuracy: 1e-6, "C where it was")
        XCTAssertEqual(try XCTUnwrap(also[0]["longitude"] as? Double), -122.0170, accuracy: 1e-6, "C where it was")
        XCTAssertEqual(also[1]["radius_m"] as? Double, 35)
        XCTAssertLessThan(try XCTUnwrap(also[1]["longitude"] as? Double), -122.0153, "the circle added, moved west of the spot")
    }

    func testTheGrabberMovesTheSheetAndTheListScrolls() throws {
        continueAfterFailure = false
        let app = launch("--ui-test-scale", "1", open: "places")
        let grabber = sheetOpened(app)
        func rests(_ word: String, _ what: String) { self.rests(grabber, word, what) }
        func dragList(_ dy: CGFloat) { self.dragList(app, dy) }
        let views = app.buttons["places.view.places"], bar = app.tabBars.firstMatch
        let place = app.staticTexts["page.title"]

        let townName = try Self.city(holding: "home-place"), awayName = try Self.city(holding: "harbour-inn")
        let town = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(townName), ")).firstMatch
        let home = app.row("places.row.home-place"), office = app.row("places.row.the-office")
        home.appears("the home's places")
        let gap = home.frame.minY - views.frame.maxY
        XCTAssertTrue((24...60).contains(gap), "the first place right under its city, Gap.head under the views, no empty gap: \(gap)")
        XCTAssertLessThan(town.frame.minY, home.frame.minY, "its city's heading over it")
        XCTAssertLessThan(home.frame.minY, office.frame.minY, "the place of today before yesterday's")
        let city = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "\(awayName), ")).firstMatch
        XCTAssertTrue(!city.exists || town.frame.minY < city.frame.minY, "the city of the newest visit first")
        keep("sheet-halfway")

        let top = home.frame.minY, sheetTop = grabber.frame.minY
        dragList(-200)
        until("halfway, a drag on the list scrolls it") { !home.isHittable || home.frame.minY < top - 100 }
        rests("Halfway", "the sheet stays halfway as its list scrolls")
        XCTAssertEqual(grabber.frame.minY, sheetTop, accuracy: 1, "the sheet unmoved by the list's scroll")
        XCTAssertFalse(place.exists, "a scroll opens no place")
        pullList(app)
        pullList(app)
        until("drags down take the list back to its top: the home's row at \(home.frame.minY), its top \(top)") {
            home.isHittable && abs(home.frame.minY - top) < 1
        }
        rests("Halfway", "a drag down the list at its top leaves the sheet halfway")
        XCTAssertEqual(grabber.frame.minY, sheetTop, accuracy: 1, "the sheet unmoved by the pull past the list's top")

        app.raiseSheet()
        rests("Raised", "the grabber raises the sheet")
        let raisedTop = home.frame.minY
        dragList(-300)
        until("raised, a drag on the list scrolls it") { !home.isHittable || home.frame.minY < raisedTop - 100 }
        rests("Raised", "the sheet stays raised as its list scrolls")
        keep("sheet-raised-scrolled")
        app.lowerSheet()
        rests("Halfway", "the grabber brings it halfway")
        app.lowerSheet()
        rests("Lowered", "the grabber lowers it")
        keep("sheet-low")
        let lowGrabber = grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        lowGrabber.drag(to: lowGrabber.withOffset(CGVector(dx: 0, dy: -250)), velocity: .slow, hold: 0.3)
        rests("Halfway", "the grabber raises it halfway from low")

        dragList(-200)
        until("Places scrolled") { !home.isHittable || home.frame.minY < top - 100 }
        func shown(_ element: XCUIElement, _ what: String) {
            until(what) { element.exists && element.frame.minY >= views.frame.maxY && element.frame.maxY <= bar.frame.minY }
        }
        app.buttons["places.view.cities"].tap()
        let first = app.buttons["places.city.\(townName)"]
        shown(first, "Cities: the city of the newest visit first, under the views")
        XCTAssertTrue(first.isHittable, "Cities starts at its top")
        XCTAssertLessThan(first.frame.minY - views.frame.maxY, 40, "Cities' first row right under the views")
        keep("sheet-cities")
        app.buttons["places.view.trips"].tap()
        let year = app.descendants(matching: .any)["places.year"].firstMatch
        shown(year, "Trips: its year under the views")
        app.raiseSheet()
        let trip = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "places.trip.")).firstMatch
        shown(trip, "Trips: its trip in the list")
        keep("sheet-trips")
        app.buttons["places.view.places"].tap()
        shown(town, "Places from its top again")
        rests("Raised", "no page moves the sheet")
        XCTAssertFalse(place.exists)
    }

    func testRaisingOrLoweringTheSheetNeverScrollsItsList() throws {
        continueAfterFailure = false
        let app = launch("--ui-test-scale", "1", open: "places")
        let grabber = sheetOpened(app)
        func rests(_ word: String, _ what: String) { self.rests(grabber, word, what) }
        func dragList(_ dy: CGFloat) { self.dragList(app, dy) }
        let views = app.buttons["places.view.places"]
        let home = app.row("places.row.home-place")
        home.appears("the home's places")
        let top = home.frame.minY
        let lowGrabber = grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))

        dragList(-150)
        until("the list scrolled") { !home.isHittable || home.frame.minY < top - 100 }
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "places.row."))
        let followed = try XCTUnwrap(rows.allElementsBoundByIndex.filter { $0.frame.minY >= views.frame.maxY + 4 }
            .min { $0.frame.minY < $1.frame.minY }, "a row under the views")
        let under = { followed.frame.minY - views.frame.maxY }
        let before = under()
        let list = app.scrollViews.containing(.button, identifier: followed.identifier).firstMatch
        let band = list.frame.minY - views.frame.maxY
        XCTAssertGreaterThanOrEqual(band, 16, "scrolled, the list starts a band under the views")
        func kept(_ what: String) {
            XCTAssertEqual(under(), before, accuracy: 1, "\(what): the row \(followed.identifier) under the views as before")
            XCTAssertEqual(list.frame.minY - views.frame.maxY, band, accuracy: 1, "\(what): the band under the views kept")
        }
        app.raiseSheet()
        rests("Raised", "the grabber raises the sheet")
        kept("halfway to raised")
        app.lowerSheet()
        rests("Halfway", "the grabber brings it halfway")
        kept("raised to halfway")
        app.lowerSheet()
        rests("Lowered", "the grabber lowers it")
        lowGrabber.drag(to: lowGrabber.withOffset(CGVector(dx: 0, dy: -250)), velocity: .slow, hold: 0.3)
        rests("Halfway", "the grabber raises it halfway from low")
        kept("low to halfway")
    }

    func testAFlickOfTheSheetKeepsTheListWhereItIs() throws {
        continueAfterFailure = false
        flickKeepsTheList(launch("--ui-test-scale", "1.825", open: "places", moving: true))
    }

    func testAFlickFromAControlInTheHeadPressesNothing() throws {
        continueAfterFailure = false
        let app = launch(open: "places", moving: true)
        let grabber = app.descendants(matching: .any)["sheet.grabber"].firstMatch
        let invite = app.buttons["places.invite"], cities = app.buttons["places.view.cities"]
        let search = app.searchFields["Search places"].firstMatch
        let walk = app.buttons["naming.close"]
        settles(grabber, "the sheet opens halfway") { $0 == "Halfway" }
        invite.appears("the invitation in the head")
        flick(invite, -110)
        settles(grabber, "a flick up from the invitation raises the sheet") { $0 == "Raised" }
        XCTAssertFalse(walk.exists, "a flick up from the invitation opens no naming")
        flick(invite, 110)
        flickedDown(grabber, "a flick down from the invitation lowers the sheet")
        XCTAssertFalse(walk.exists, "a flick down from the invitation opens no naming")
        flick(cities, -110)
        settles(grabber, "a flick up from a view raises the sheet") { $0 == "Raised" }
        XCTAssertFalse(cities.isSelected, "a flick from Cities leaves Places chosen")
        XCTAssertTrue(app.row("places.row.home-place").exists, "the places still listed")
        search.appears("the search in the head")
        flick(search, 110)
        flickedDown(grabber, "a flick down from the search lowers the sheet")
        XCTAssertFalse(walk.exists)
        invite.tap()
        walk.appears("a tap on the invitation opens the naming")
    }

    func testTheLargestText() throws {
        continueAfterFailure = false
        let app = launch(open: "places", text: .largest)
        let invite = app.buttons["places.invite"]
        invite.appears()
        keep("largest-list")
        invite.tap()
        app.buttons["naming.name.0"].appears("the home's names for its stay")
        keep("largest-naming")
        XCTAssertTrue(app.buttons["naming.skip"].isHittable, "Skip stays on screen, pinned at the foot")
        app.drag(up: true)
        keep("largest-naming-scrolled")
        app.buttons["naming.close"].tap()
        invite.appears("Close ends the sitting")

        app.raiseSheet()
        keep("largest-list-rows")
        let office = app.descendants(matching: .any)["places.row.the-office"].firstMatch
        office.appears()
        let trips = app.buttons["places.view.trips"].firstMatch, bar = app.tabBars.firstMatch
        let clear = { office.frame.minY >= trips.frame.maxY - 8 && office.frame.maxY <= bar.frame.minY + 8 }
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        for _ in 0..<8 where !clear() {
            start.drag(to: start.withOffset(CGVector(dx: 0, dy: -60)), velocity: .slow, hold: 0.3)
        }
        until("The Office between the pills and the tab bar", clear)
        office.tap()
        app.staticTexts["page.title"].appears()
        app.staticTexts["place.rhythm"].appears()
        keep("largest-place")
        let photos = app.scrolledTo("place.photos")
        let photo = NSPredicate(format: "label BEGINSWITH %@", "Photo, ")
        XCTAssertEqual(photos.descendants(matching: .any).matching(photo).count, 3, "a row of three")
        photos.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "View all ")).firstMatch.tap()
        app.descendants(matching: .any).matching(photo).firstMatch.appears("every photo")
        keep("largest-photos")
        let second = app.descendants(matching: .any)["place.photo.60"].firstMatch
        app.bringIntoView(second)
        XCTAssertTrue(second.exists, "the second page was read")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.scrolledTo("place.person.person:person-a").exists, "its people, at the largest size")
        XCTAssertTrue(app.scrolledTo("place.visit.0").exists, "its visits, at the largest size")
        keep("largest-place-visits")
    }

    func testAFlickAtTheLargestTextKeepsTheList() throws {
        continueAfterFailure = false
        flickKeepsTheList(launch("--ui-test-scale", "1.825", open: "places", text: .largest, moving: true))
    }


    private func sheetOpened(_ app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["places.list"].firstMatch.appears("Places")
        let grabber = app.descendants(matching: .any)["sheet.grabber"].firstMatch
        rests(grabber, "Halfway", "the sheet opens halfway")
        return grabber
    }

    private func rests(_ grabber: XCUIElement, _ word: String, _ what: String) {
        until(what) { grabber.value as? String == word }
        grabber.holdsStill(for: 2, "the sheet stays \(word)")
    }

    private func dragList(_ app: XCUIApplication, _ dy: CGFloat) {
        let views = app.buttons["places.view.places"], bar = app.tabBars.firstMatch
        let start = app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: app.frame.midX, dy: (views.frame.maxY + bar.frame.minY) / 2))
        start.drag(to: start.withOffset(CGVector(dx: 0, dy: dy)), velocity: .slow, hold: 0.3)
    }

    private func pullList(_ app: XCUIApplication) {
        let list = app.scrollViews.containing(.button, identifier: "places.row.home-place").firstMatch
        let from = list.frame.minY + 24, to = app.frame.maxY - 16
        let start = app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: app.frame.midX, dy: from))
        start.drag(to: start.withOffset(CGVector(dx: 0, dy: to - from)), velocity: .slow, hold: 0.3)
    }

    private func flickedDown(_ grabber: XCUIElement, _ what: String) {
        settles(grabber, what) { $0 == "Halfway" || $0 == "Lowered" }
        guard grabber.value as? String == "Lowered" else { return }
        let low = grabber.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        low.drag(to: low.withOffset(CGVector(dx: 0, dy: -250)), velocity: .slow, hold: 0.3)
        settles(grabber, "the grabber brings it back halfway, its head in reach") { $0 == "Halfway" }
    }

    private func flickKeepsTheList(_ app: XCUIApplication) {
        let grabber = app.descendants(matching: .any)["sheet.grabber"].firstMatch
        let views = app.buttons["places.view.trips"]
        func settles(_ what: String, _ there: @escaping (String?) -> Bool) { self.settles(grabber, what, there) }
        func flick(_ by: CGFloat) { self.flick(grabber, by) }
        settles("the sheet opens halfway") { $0 == "Halfway" }
        app.raiseSheet()
        settles("the grabber raises the sheet") { $0 == "Raised" }
        let home = app.row("places.row.home-place")
        home.appears("the home's places")
        let before = home.frame.minY - views.frame.maxY
        func kept(_ what: String) {
            XCTAssertTrue(home.exists, "\(what): the home's row still in the list")
            XCTAssertEqual(home.frame.minY - views.frame.maxY, before, accuracy: 1, "\(what): the home's row under the views as before")
        }

        flick(70)
        settles("a flick down lowers the sheet") { $0 != "Raised" }
        let lowered = grabber.value as? String
        app.raiseSheet()
        settles("the grabber raises it again") { $0 == "Raised" }
        kept("flicked down, raised by the grabber")
        app.lowerSheet()
        settles("the grabber lowers it") { $0 != "Raised" }
        flick(-70)
        settles("a flick up raises the sheet") { $0 != lowered || $0 == "Raised" }
        if grabber.value as? String != "Raised" {
            app.raiseSheet()
            settles("the grabber raises it the rest of the way") { $0 == "Raised" }
        }
        kept("flicked up")
    }

    private func settles(_ grabber: XCUIElement, _ what: String, _ there: @escaping (String?) -> Bool) {
        var last = CGFloat.nan
        until("\(what): the grabber says \(String(describing: grabber.value)) at \(grabber.frame.minY)") {
            let top = grabber.frame.minY
            defer { last = top }
            return there(grabber.value as? String) && top == last
        }
        grabber.holdsStill(for: 2, "the sheet stays where it settled")
    }

    private func flick(_ element: XCUIElement, _ by: CGFloat) {
        let start = element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.drag(to: start.withOffset(CGVector(dx: 0, dy: by)), velocity: XCUIGestureVelocity(rawValue: 1500))
    }

    private var tripYear: Int {
        let calendar = Calendar(identifier: .gregorian)
        return calendar.component(.year, from: calendar.date(byAdding: .month, value: -1, to: TestClock.now)!)
    }

    private func metres(_ words: String?) -> Double? {
        guard let parts = words?.split(separator: "\u{00A0}"), parts.count == 2, let number = Double(parts[0]) else { return nil }
        return parts[1] == "km" ? number * 1_000 : number
    }

    @discardableResult
    private func stated(_ app: XCUIApplication, _ what: String, _ holds: @escaping ([String: Any]) -> Bool) -> [String: Any]? {
        let element = app.descendants(matching: .any)["ui-test.stated"].firstMatch
        func read() -> [String: Any]? {
            guard element.exists else { return nil }
            return (try? JSONSerialization.jsonObject(with: Data(element.label.utf8))) as? [String: Any]
        }
        until(what) { read().map(holds) ?? false }
        return read()
    }

    private static func canned(_ name: String) throws -> [String: Any] {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("homelink/Tests/Fixtures/pages/canned/\(name).json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], "\(name).json is an object")
    }

    private static func trip(in year: Int) throws -> (title: String, city: String) {
        let trip = (try canned("year.\(year)")["trips"] as? [[String: Any]])?.first
        let title = try XCTUnwrap(trip?["title"] as? String, "year.\(year).json holds a trip")
        let city = try XCTUnwrap((trip?["route"] as? [String])?.first, "its trip names a city")
        return (title, city)
    }

    private static func city(of slug: String) throws -> String {
        let head = try canned("place.\(slug)")["head"] as? [String: Any]
        return try XCTUnwrap(head?["line"] as? String, "place.\(slug).json says its city")
    }

    private static func city(holding slug: String) throws -> String {
        let list = try canned("places.list")
        let city = (list["cities"] as? [[String: Any]] ?? []).first { city in
            ["places", "once"].contains { member in (city[member] as? [[String: Any]] ?? []).contains { $0["slug"] as? String == slug } }
        }
        return try XCTUnwrap(city?["title"] as? String, "places.list.json holds \(slug) in a city")
    }

    private static func also(_ action: [String: Any]) -> [[String: Any]]? {
        action["also"] as? [[String: Any]]
    }
}

private extension XCUIApplication {
    var namingField: XCUIElement {
        textFields.matching(NSPredicate(format: "identifier == %@ AND label == %@", "name.field", "Type a name")).firstMatch
    }

    func openPlaces() {
        openTab("Places")
        let list = descendants(matching: .any)["places.list"].firstMatch
        for _ in 0..<3 where !list.exists {
            let back = navigationBars.buttons.firstMatch
            guard back.exists else { break }
            back.tap()
        }
        list.appears()
    }

    func row(_ prefix: String) -> XCUIElement {
        buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", prefix)).firstMatch
    }

    func openPlace(_ row: String) {
        openPlaces()
        let place = self.row(row)
        place.appears()
        raiseSheet()
        place.tap()
        staticTexts["page.title"].appears()
    }
}

private extension XCUIElement {
    func showsGround(_ what: @autoclosure () -> String, file: StaticString = #filePath, line: UInt = #line) {
        until(what(), file: file, line: line) {
            guard self.exists, let image = self.screenshot().image.cgImage else { return false }
            let width = image.width, height = max(1, image.height / 5)
            var pixels = [UInt8](repeating: 0, count: width * height * 4)
            let painted = pixels.withUnsafeMutableBytes { bytes -> Bool in
                guard let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                              bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
                context.draw(image, in: CGRect(x: 0, y: height - image.height, width: width, height: image.height))
                return true
            }
            guard painted else { return false }
            let lightness = stride(from: 0, to: pixels.count, by: 4).map { Int(pixels[$0]) + Int(pixels[$0 + 1]) + Int(pixels[$0 + 2]) }
            return (lightness.max() ?? 0) - (lightness.min() ?? 0) > 12
        }
    }

    func apart(_ one: String, _ other: String, _ what: @autoclosure () -> String, file: StaticString = #filePath, line: UInt = #line) {
        let named = { (name: String) in self.descendants(matching: .any).matching(NSPredicate(format: "label == %@", name)).firstMatch }
        let (first, second) = (named(one), named(other))
        until(what(), file: file, line: line) {
            guard first.exists, second.exists else { return false }
            return hypot(first.frame.midX - second.frame.midX, first.frame.midY - second.frame.midY) > 40
        }
    }
}
