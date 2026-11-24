import HomeLink
import LifestreamCaptureCore
import UIKit
import XCTest
@testable import Lifestream

@MainActor
final class CircleEditTests: XCTestCase {
    private final class History: UIResponder {
        let manager = UndoManager()
        override var undoManager: UndoManager? { manager }
    }

    private let a = PlaceCoordinate(latitude: 37.3420, longitude: -122.0170)

    private func edited() -> (CircleEditing, History) {
        let editing = CircleEditing([PlaceCircle(centre: a, radiusMeters: 55),
                                     PlaceCircle(centre: a.moved(north: 0, east: 65), radiusMeters: 30),
                                     PlaceCircle(centre: a.moved(north: -115, east: 0), radiusMeters: 80)],
                                    slug: "place-a")
        let history = History()
        history.manager.groupsByEvent = false
        editing.history = history
        return (editing, history)
    }

    private func change(_ history: History, _ make: () -> Void) {
        history.manager.beginUndoGrouping()
        make()
        history.manager.endUndoGrouping()
    }

    private func standing(_ editing: CircleEditing) -> (reaches: [Double], selected: Int?) {
        (editing.rows.map(\.circle.radiusMeters), editing.rows.firstIndex(where: \.selected))
    }

    func testThePointsLightAndCountByTheCircleThatWinsThem() throws {
        let editing = CircleEditing([PlaceCircle(centre: a, radiusMeters: 300)], slug: "home")
        XCTAssertEqual(editing.line, "Stays not read yet", "no count before the home's points")
        let inner = a.moved(north: 50, east: 0), outer = a.moved(north: -150, east: 0)
        let answer: [String: Any] = [
            "position": "1:1", "today": "2026-01-01", "slug": "home",
            "circle": ["latitude": a.latitude, "longitude": a.longitude, "radius_m": 300],
            "others": [["slug": "cafe", "latitude": inner.latitude, "longitude": inner.longitude, "radius_m": 60]],
            "points": [["latitude": inner.latitude, "longitude": inner.longitude, "count": 4],
                       ["latitude": outer.latitude, "longitude": outer.longitude, "count": 2]],
            "held": 5, "read": true, "line": NSNull(), "counting": false,
        ]
        editing.know(try JSONDecoder().decode(HomeLink.Pages.PlaceEdit.self, from: JSONSerialization.data(withJSONObject: answer)))
        XCTAssertEqual(editing.line, "Takes in 7\(Words.nbsp)stays", "the 5 its id holds and the 2 only it holds, not the cafe's 4")
        XCTAssertEqual(editing.points.map(editing.taken), [false, true], "the cafe's point stays grey inside the wider circle")
        editing.resize(20)
        XCTAssertEqual(editing.line, "Takes in 5\(Words.nbsp)stays")
    }

    func testEachUndoTakesBackOneChangeInOrderAcrossTheCirclesAndSelectsItsCircle() {
        let (editing, history) = edited()
        let ids = editing.rows.map(\.id)
        change(history) { editing.resize(60) }
        XCTAssertTrue(editing.select(id: ids[1]))
        change(history) { editing.resize(35) }
        change(history) { editing.remove(id: ids[0]) }
        XCTAssertEqual(standing(editing).reaches, [35, 80])
        XCTAssertEqual(standing(editing).selected, 0, "B the first, still selected")

        history.manager.undo()
        XCTAssertEqual(standing(editing).reaches, [60, 35, 80], "A back where it stood, as changed")
        XCTAssertEqual(standing(editing).selected, 1, "B, selected when A was removed")
        XCTAssertEqual(editing.radius, 35, "the stepper on the circle selected")
        history.manager.undo()
        XCTAssertEqual(standing(editing).reaches, [60, 30, 80], "B's change taken back")
        XCTAssertEqual(standing(editing).selected, 1)
        XCTAssertEqual(editing.radius, 30)
        history.manager.undo()
        XCTAssertEqual(standing(editing).reaches, [55, 30, 80], "A's change taken back")
        XCTAssertEqual(standing(editing).selected, 0, "A, the circle it changed, selected")
        XCTAssertEqual(editing.radius, 55)
        XCTAssertFalse(history.manager.canUndo, "three changes, no more: selecting is none")

        history.manager.redo()
        XCTAssertEqual(standing(editing).reaches, [60, 30, 80], "A's change again")
        XCTAssertEqual(standing(editing).selected, 0)
        history.manager.redo()
        XCTAssertEqual(standing(editing).reaches, [60, 35, 80], "B's change again")
        XCTAssertEqual(standing(editing).selected, 1)
        history.manager.redo()
        XCTAssertEqual(standing(editing).reaches, [35, 80], "A removed again")
        XCTAssertEqual(standing(editing).selected, 0)
        XCTAssertFalse(history.manager.canRedo)
    }

    func testACircleAddedAndTheMapMovedUnderItAreTwoChangesTheMoveTakenBackFirst() {
        let (editing, history) = edited()
        let b = editing.rows[1].id
        XCTAssertTrue(editing.select(id: b))
        change(history) { editing.add() }
        XCTAssertEqual(editing.rows.count, 4)
        XCTAssertEqual(standing(editing).selected, 3, "the circle added, selected")
        XCTAssertEqual(editing.radius, 30, "at the reach of the one it was added beside")
        let put = editing.centre
        change(history) {
            editing.lift()
            editing.move(to: put.moved(north: 0, east: -40))
            editing.set()
        }
        XCTAssertEqual(editing.moved, "Moved 40\(Words.nbsp)m west")

        history.manager.undo()
        XCTAssertEqual(editing.rows.count, 4, "the move taken back first")
        XCTAssertEqual(standing(editing).selected, 3)
        XCTAssertEqual(editing.centre, put)
        XCTAssertEqual(editing.moved, "Where it was")
        history.manager.undo()
        XCTAssertEqual(editing.rows.count, 3, "then the circle")
        XCTAssertEqual(standing(editing).selected, 1, "the one it was added beside, selected")
        XCTAssertFalse(history.manager.canUndo)

        history.manager.redo()
        XCTAssertEqual(editing.rows.count, 4)
        XCTAssertEqual(editing.centre, put, "given again where it was put")
        history.manager.redo()
        XCTAssertEqual(editing.moved, "Moved 40\(Words.nbsp)m west", "and moved again")
    }
}
