import Foundation
import HomeLink
import LifestreamCaptureCore
import SwiftUI
import XCTest

@testable import Cockpit
@testable import Lifestream

final class DayTimelineTests: XCTestCase {
    private static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("homelink/Tests/Fixtures/pages")

    private static func data(_ name: String) throws -> Data {
        try Data(contentsOf: fixtures.appendingPathComponent(name))
    }

    private static func page(_ name: String) throws -> HomeLink.Pages.Day {
        try JSONDecoder().decode(HomeLink.Pages.Day.self, from: data(name))
    }

    private static func page(_ name: String, side change: (inout [String: Any]) -> Void) throws -> HomeLink.Pages.Day {
        var body = try XCTUnwrap(JSONSerialization.jsonObject(with: data(name)) as? [String: Any])
        var side = try XCTUnwrap(body["side"] as? [String: Any])
        change(&side)
        body["side"] = side
        return try JSONDecoder().decode(HomeLink.Pages.Day.self, from: JSONSerialization.data(withJSONObject: body))
    }

    private static func laid(_ page: HomeLink.Pages.Day, open: Set<String> = []) -> [DayPiece] {
        DayLayout.of(page, isOpen: { key, folded in folded == open.contains(key) }, lead: 0).sections.flatMap { $0.header + $0.pieces }
    }


    @MainActor func testEachPlaceOnTheMapIsTheHomesPlaceOverTheCutSizedByItsShareOfTheMost() throws {
        let page = try Self.page("day.side.json")
        let stays = DaySide.onMap(page.side)
        let over = page.side.places.filter { $0.ms >= DaySide.leastOnMap * 60_000 }
        XCTAssertFalse(over.isEmpty, "the day has places worth a disc")
        XCTAssertEqual(stays.map(\.id), over.map(\.key), "the home's places in its order, those under ten minutes left off")
        XCTAssertEqual(stays.map(\.minutes), over.map { $0.ms / 60_000 })

        let frame = MapFrame(stays: stays, size: CGSize(width: 361, height: DayMapCard.height), phone: true)
        let most = try XCTUnwrap(stays.max { $0.minutes < $1.minutes })
        XCTAssertEqual(try XCTUnwrap(frame.radius[most.id]), 24, accuracy: 0.001, "the day's most: 6 + 18")
    }

    @MainActor func testADayWhosePlacesAreAllUnderTheCutDrawsNoMapCard() throws {
        let short = try Self.page("day.side.json") { side in
            side["places"] = (side["places"] as? [[String: Any]] ?? []).map { place in place.merging(["ms": 5 * 60_000]) { $1 } }
        }
        XCTAssertFalse(short.side.places.isEmpty, "the places stay places of the day")
        XCTAssertEqual(DaySide.onMap(short.side).map(\.id), [], "five minutes each, under the cut")
        XCTAssertFalse(DaySide.drawsMap(short.side), "nothing on the map draws no card")
        let nowhere = try Self.page("day.side.json") { side in side["located"] = false }
        XCTAssertFalse(DaySide.drawsMap(nowhere.side), "a day that went nowhere has none")
        XCTAssertTrue(DaySide.drawsMap(try Self.page("day.side.json").side))
    }


    @MainActor func testTripsMapDrawsAgainWhatChangedInTheSameCities() {
        func city(_ name: String, _ latitude: Double, nights: Int, home: Bool = false) -> TripsMap.City {
            TripsMap.City(name: name, point: PlaceCoordinate(latitude: latitude, longitude: 20.5), nights: nights, home: home)
        }
        func year(_ cities: [TripsMap.City]) -> TripsDrawing { TripsMap(cities: cities, label: "a year").drawing }
        let home = city("Home Town", 10, nights: 300, home: true), away = city("Synthetic City", 20, nights: 4)
        let drawn = year([home, away])
        XCTAssertEqual(drawn.lines, [], "a year's map draws no line from home: a line says a path taken")
        XCTAssertEqual(drawn.changes(from: nil), .init(marks: true, lines: true, fit: true), "the first drawing is all drawn")
        XCTAssertEqual(drawn.changes(from: drawn), .init(marks: false, lines: false, fit: false), "the same, nothing")

        let nights = year([home, city("Synthetic City", 20, nights: 40)])
        XCTAssertEqual(nights.cities.map(\.id), drawn.cities.map(\.id), "the same city ids")
        XCTAssertEqual(nights.changes(from: drawn), .init(marks: true, lines: false, fit: false))

        let moved = year([city("Home Town", 10, nights: 300), city("Synthetic City", 20, nights: 4, home: true)])
        XCTAssertEqual(moved.lines, [])
        XCTAssertEqual(moved.changes(from: drawn), .init(marks: true, lines: false, fit: false))

        let route = TripsMap(cities: [home, away, home], route: true, label: "a trip").drawing
        XCTAssertEqual(route.lines, [[home.point, away.point, home.point]], "a trip's route is its one line")
        XCTAssertEqual(route.cities, [home, away])
        XCTAssertEqual(route.changes(from: drawn), .init(marks: false, lines: true, fit: false))
    }


    func testADayWithNoPlaceIsEachThingItsOwnRowWithNoHeadOrHour() throws {
        let page = try Self.page("day.placeless.json")
        let pieces = Self.laid(page)
        let rows = pieces.compactMap { piece -> String? in
            if case .row(let row, let nested) = piece.kind, piece.owner == .track, !nested { row.key } else { nil }
        }
        let chapter = try XCTUnwrap(page.chapters.first { $0.kind == .day })
        XCTAssertEqual(rows, chapter.blocks.flatMap(\.rows).map(\.key), "each row of the home's list laid, none nested")
        XCTAssertFalse(pieces.contains { piece in
            switch piece.kind {
            case .head, .hour, .names, .move: true
            default: false
            }
        }, "no head, no hour, no names line")
    }


    func testANameInAFoldedPlacesLineOpensARowOfItsOwnChapter() throws {
        let page = try Self.page("day.brief.json")
        let named = page.chapters.filter { !$0.names.isEmpty }
        XCTAssertFalse(named.isEmpty)
        for chapter in named {
            for name in chapter.names {
                XCTAssertNotNil(DayReading.first(of: name, in: chapter), "\(name.text) opens a row of its own chapter")
            }
        }
        let folded = Self.laid(page).compactMap { piece -> String? in if case .names(let chapter, _) = piece.kind { chapter.key } else { nil } }
        XCTAssertEqual(folded, named.filter { $0.kind != .move && $0.folded }.map(\.key), "each folded chapter with names draws its names line")
    }


    func testTheOpenStaysRowsAreLaidByHourAndAnHourOpensItsRows() throws {
        let page = try Self.page("day.brief.json")
        let chapter = try XCTUnwrap(page.chapters.first { $0.blocks.contains { $0.kind == .hour } })
        let hour = try XCTUnwrap(chapter.blocks.first { $0.kind == .hour })
        let shut = Self.laid(page, open: [chapter.key])
        XCTAssertTrue(shut.contains { $0.id == "hour:\(hour.key)" }, "the chapter open, its hours drawn")
        XCTAssertFalse(shut.contains { $0.id == hour.rows[0].key }, "an hour folded keeps its rows")
        let open = Self.laid(page, open: [chapter.key, hour.key])
        let nested = open.compactMap { piece -> String? in if case .row(let row, true) = piece.kind { row.key } else { nil } }
        XCTAssertEqual(nested, hour.rows.map(\.key), "the hour open, its rows nested, in the home's order")
    }


    @MainActor func testNameItStandsOnlyOnAnUnnamedStayAtASpotOnTheListToName() throws {
        let page = try Self.page("day.past.json")
        let unnamed = page.chapters.filter(DayReading.unnamed)
        let keys = unnamed.compactMap(\.head?.place)
        XCTAssertEqual(keys.count, 2, "the past day's two stays at spots not named")
        let spots = try HomeLink.Places.spots(in: JSONSerialization.data(withJSONObject: ["spots": [keys[0], "spot:10.7,20.5"].map { key in
            ["latitude": 10.5, "longitude": 20.5, "worth": true, "key": key] as [String: Any]
        }]))
        XCTAssertEqual(DayList.naming(page, toName: []), [:], "no list of spots to name: no link")
        XCTAssertEqual(DayList.naming(page, toName: spots).mapValues(\.key), [unnamed[0].key: keys[0]],
                       "the stay at the spot on the list alone, never a stay elsewhere")

        let head = { (nameIt: StayHead.NameIt?) in
            StayHead("Near Synthetic Home", time: "09:00", length: "3h", glyph: .place, line: "1.8 km away", unnamed: true,
                     nameIt: nameIt)
        }
        XCTAssertEqual(Self.height(head(StayHead.NameIt {})), Self.height(head(nil)), "Name it arriving moves nothing")
    }


    func testTheMidnightDividerStandsWhereTheHomePutsIt() throws {
        let page = try Self.page("day.midnight.json")
        let open = Set(page.chapters.map(\.key) + page.chapters.flatMap(\.blocks).map(\.key))
        let pieces = Self.laid(page, open: open)
        let dividers = pieces.indices.filter { if case .divider = pieces[$0].kind { true } else { false } }
        XCTAssertEqual(dividers.count, 1, "one midnight in a day")
        let carrier = page.chapters.first { $0.divider != nil }.map { ["head:\($0.key)", "move:\($0.key)"] }
            ?? page.chapters.flatMap(\.blocks).first { $0.divider != nil }.map { ["hour:\($0.key)"] }
            ?? DayReading.rows(of: page).first { $0.divider != nil }.map { [$0.key] }
        XCTAssertTrue(try XCTUnwrap(carrier, "the home marks where midnight falls").contains(pieces[dividers[0] + 1].id),
                      "the divider sits right before what the home marks")
    }


    @MainActor private static func height(_ view: some View) -> CGFloat {
        UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: 393, height: CGFloat.greatestFiniteMagnitude)).height
    }
}
