import Foundation
import LifestreamCaptureCore
import UserNotifications

protocol CheckInNotificationSource: Sendable {
    func authorization() async -> String
    func requestAuthorization() async throws
    func schedule(_ prompt: CheckInPrompt, now: Date) async throws
    func cancel(_ ids: [String]) async
    func delivered() async -> [String: Date]
}

actor CheckInNotifications: CheckInNotificationSource {
    private let center = UNUserNotificationCenter.current()
    private let bridge: CheckInNotificationBridge

    init(handler: @escaping @Sendable (String, String, Date) async -> Void) {
        let bridge = CheckInNotificationBridge(handler: handler)
        self.bridge = bridge
        center.delegate = bridge
        center.setNotificationCategories([UNNotificationCategory(identifier: "checkin", actions: [],
            intentIdentifiers: [], options: .customDismissAction)])
    }
    func authorization() async -> String {
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .ephemeral: "authorized"
        case .denied: "denied"
        case .provisional: "provisional"
        case .notDetermined: "not_determined"
        @unknown default: "not_determined"
        }
    }
    func requestAuthorization() async throws {
        _ = try await center.requestAuthorization(options: [.alert, .sound])
    }
    func schedule(_ prompt: CheckInPrompt, now: Date) async throws {
        guard prompt.form != "week" else { return }
        for (index, date) in [prompt.scheduledFor, prompt.reminder].enumerated() where date > now {
            let content = UNMutableNotificationContent()
            content.title = prompt.form == "vigilance" ? "Ready to focus?" : "How am I?"
            content.body = prompt.form == "day" ? "How was today?" : prompt.form == "vigilance"
                ? "Time for the afternoon reaction test." : "How are you, right now?"
            content.categoryIdentifier = "checkin"
            content.userInfo = ["checkin_prompt": prompt.id]
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: max(1, date.timeIntervalSince(now)), repeats: false)
            try await center.add(UNNotificationRequest(identifier: prompt.notificationIDs[index], content: content, trigger: trigger))
        }
    }
    func cancel(_ ids: [String]) {
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
    }
    func delivered() async -> [String: Date] {
        var result: [String: Date] = [:]
        for notification in await center.deliveredNotifications() {
            guard let id = notification.request.content.userInfo["checkin_prompt"] as? String else { continue }
            result[id] = min(result[id] ?? notification.date, notification.date)
        }
        return result
    }
}

private final class CheckInNotificationBridge: NSObject, UNUserNotificationCenterDelegate, Sendable {
    let handler: @Sendable (String, String, Date) async -> Void
    init(handler: @escaping @Sendable (String, String, Date) async -> Void) { self.handler = handler }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completion: @escaping @Sendable (UNNotificationPresentationOptions) -> Void) {
        let id = notification.request.content.userInfo["checkin_prompt"] as? String
        let deliveredAt = notification.date
        Task { @MainActor [handler] in
            if let id { await handler(id, "delivered", deliveredAt) }
            completion([.banner, .list])
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completion: @escaping @Sendable () -> Void) {
        let id = response.notification.request.content.userInfo["checkin_prompt"] as? String
        let deliveredAt = response.notification.date
        let dismissed = response.actionIdentifier == UNNotificationDismissActionIdentifier
        let respondedAt = AppClock.now
        Task { @MainActor [handler] in
            defer { completion() }
            guard let id else { return }
            await handler(id, "delivered", deliveredAt)
            await handler(id, dismissed ? "dismissed" : "opened", respondedAt)
            if !dismissed {
                AppNavigation.shared.openCheckIn(.init(destination: .prompt, promptID: id))
            }
        }
    }
}

actor TestCheckInNotifications: CheckInNotificationSource {
    var state = "not_determined"
    var requests = 0
    var scheduled: [CheckInPrompt] = []
    var presentations: [String: Date] = [:]
    func authorization() -> String { state }
    func requestAuthorization() { requests += 1; state = "authorized" }
    func schedule(_ prompt: CheckInPrompt, now: Date) { scheduled.append(prompt) }
    func cancel(_ ids: [String]) { scheduled.removeAll { !Set($0.notificationIDs).isDisjoint(with: ids) } }
    func delivered() -> [String: Date] { presentations }
    func setAuthorization(_ value: String) { state = value }
}
