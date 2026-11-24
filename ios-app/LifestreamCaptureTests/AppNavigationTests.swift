import XCTest
import UserNotifications
@testable import Lifestream

@MainActor
final class AppNavigationTests: XCTestCase {
    func testNotificationTapReachesPromptFromSystemCallback() async throws {
        try await checkNotificationCallback(action: UNNotificationDefaultActionIdentifier)
    }
    func testNotificationDismissalCompletesWithoutOpeningForm() async throws {
        try await checkNotificationCallback(action: UNNotificationDismissActionIdentifier)
    }
    func testUnrelatedNotificationStillCompletes() async throws {
        try await checkNotificationCallback(action: UNNotificationDefaultActionIdentifier, promptID: nil)
    }
    func testForegroundNotificationCompletesWithoutOpeningForm() async throws {
        try await checkNotificationCallback(action: nil)
    }
    private func checkNotificationCallback(action: String?, promptID: String? = "synthetic-prompt") async throws {
        let center = UNUserNotificationCenter.current()
        let previousDelegate = center.delegate
        let originalTab = AppNavigation.shared.selectedTab
        let originalPresented = AppNavigation.shared.presented
        let originalRoute = AppNavigation.shared.checkInRoute
        defer {
            center.delegate = previousDelegate
            AppNavigation.shared.selectedTab = originalTab
            AppNavigation.shared.presented = originalPresented
            AppNavigation.shared.checkInRoute = originalRoute
        }
        let events = NotificationEventProbe()
        let source = CheckInNotifications { id, event, _ in await events.record(id, event) }
        let delegate = try XCTUnwrap(center.delegate)
        let content = UNMutableNotificationContent()
        if let promptID { content.userInfo = ["checkin_prompt": promptID] }
        let request = UNNotificationRequest(identifier: "synthetic-notification", content: content, trigger: nil)
        let notification = try XCTUnwrap(UNNotification(coder: NotificationFixtureCoder([
            "request": request, "date": Date()
        ])))
        XCTAssertEqual(notification.request.content.userInfo["checkin_prompt"] as? String, promptID)
        AppNavigation.shared.selectedTab = .places
        AppNavigation.shared.presented = .notes(.folders)
        AppNavigation.shared.checkInRoute = nil
        let completed = Happened()
        if let action {
            let response = try XCTUnwrap(UNNotificationResponse(coder: NotificationFixtureCoder([
                "notification": notification, "actionIdentifier": action
            ])))
            delegate.userNotificationCenter?(center, didReceive: response, withCompletionHandler: {
                XCTAssertTrue(Thread.isMainThread, "UIKit finishes notification launch on the main thread")
                completed.note()
            })
        } else {
            delegate.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: { options in
                XCTAssertTrue(Thread.isMainThread)
                XCTAssertEqual(options, [.banner, .list])
                completed.note()
            })
        }
        try await until("completed.value") { completed.value }
        let opens = promptID != nil && action == UNNotificationDefaultActionIdentifier
        XCTAssertEqual(AppNavigation.shared.selectedTab, opens ? .days : .places)
        XCTAssertEqual(AppNavigation.shared.presented, opens ? nil : .notes(.folders))
        XCTAssertEqual(AppNavigation.shared.checkInRoute?.promptID, opens ? promptID : nil)
        let recorded = await events.values
        let outcome = action == UNNotificationDismissActionIdentifier ? "dismissed" : "opened"
        XCTAssertEqual(recorded, promptID.map { id in
            ["\(id):delivered"] + (action == nil ? [] : ["\(id):\(outcome)"])
        } ?? [])
        withExtendedLifetime(source) {}
    }
}

private actor NotificationEventProbe {
    var values: [String] = []
    func record(_ id: String, _ event: String) { values.append("\(id):\(event)") }
}

private final class NotificationFixtureCoder: NSCoder {
    let fields: [String: Any]
    init(_ fields: [String: Any]) { self.fields = fields }
    override var allowsKeyedCoding: Bool { true }
    override func decodeObject(forKey key: String) -> Any? { fields[key] }
}
