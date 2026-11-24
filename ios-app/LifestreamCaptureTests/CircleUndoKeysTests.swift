import LifestreamCaptureCore
import SwiftUI
import UIKit
import XCTest
@testable import Lifestream

@MainActor
final class CircleUndoKeysTests: XCTestCase {
    private let a = PlaceCoordinate(latitude: 37.3420, longitude: -122.0170)

    private func shown(_ editing: CircleEditing) throws -> CircleMapView {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "the app's scene")
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 300)
        window.rootViewController = UIHostingController(rootView: CircleEdit(editing: editing))
        window.makeKeyAndVisible()
        window.layoutIfNeeded()
        addTeardownBlock { @MainActor in
            window.rootViewController = nil
            window.isHidden = true
        }
        XCTAssertTrue(window.isKeyWindow, "the edit's window takes the keys")
        return try XCTUnwrap(Self.map(in: window), "the circle edit's map in the window")
    }

    private static func map(in view: UIView) -> CircleMapView? {
        if let map = view as? CircleMapView { return map }
        return view.subviews.lazy.compactMap { map(in: $0) }.first
    }

    private func key(_ map: CircleMapView, _ title: String, _ modifiers: UIKeyModifierFlags) throws -> UIKeyCommand {
        let command = try XCTUnwrap(map.keyCommands?.first { $0.title == title }, "the map's \(title) key")
        XCTAssertEqual(command.input, "z")
        XCTAssertEqual(command.modifierFlags, modifiers)
        XCTAssertTrue(command.wantsPriorityOverSystemBehavior, "\(title) is the edit's before the system's")
        return command
    }

    private func press(_ command: UIKeyCommand) throws {
        let action = try XCTUnwrap(command.action, "\(command.title) names its action")
        XCTAssertTrue(UIApplication.shared.sendAction(action, to: nil, from: command, for: nil), "\(command.title) reaches a responder")
    }

    func testTheMapTakesTheKeysAndItsUndoAndRedoKeysTakeBackAndGiveAgainAnEdit() throws {
        let editing = CircleEditing([PlaceCircle(centre: a, radiusMeters: 55)], slug: "place-a")
        let map = try shown(editing)
        XCTAssertTrue(map.isFirstResponder, "the map listens for the keys once in the window")
        XCTAssertTrue(editing.history === map, "the edit records its steps on the map")
        let manager = try XCTUnwrap(map.undoManager, "the map's undo manager")
        let undo = try key(map, "Undo", .command)
        let redo = try key(map, "Redo", [.command, .shift])

        manager.beginUndoGrouping()
        editing.resize(60)
        manager.endUndoGrouping()
        XCTAssertTrue(manager.canUndo, "the resize recorded on the map's undo manager")
        XCTAssertEqual(manager.undoActionName, "Resize")

        try press(undo)
        XCTAssertEqual(editing.radius, 55, "⌘Z takes the resize back")
        XCTAssertFalse(editing.changed)
        XCTAssertTrue(manager.canRedo)

        try press(redo)
        XCTAssertEqual(editing.radius, 60, "⇧⌘Z gives it again")
        XCTAssertTrue(editing.changed)
        XCTAssertEqual(editing.rows.map(\.circle.radiusMeters), [60])
    }
}
