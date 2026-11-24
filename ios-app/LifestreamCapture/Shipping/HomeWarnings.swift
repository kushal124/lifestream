import Foundation
import HomeLink
import LifestreamCaptureCore
import os
import UserNotifications

@MainActor
protocol WarningCenter: AnyObject {
    func post(id: String, body: String, after delay: TimeInterval?, sound: Bool) async throws
    func remove(_ ids: [String])
}

@MainActor
final class HomeWarnings {
    static let silenceID = "home.silence"
    static let silence: TimeInterval = 6 * 3600
    static let expiryID = "build.expiry"

    private let center: any WarningCenter
    private let build: BuildLife?
    private let now: () -> Date
    private let clock: () -> HomeClock
    private(set) var scheduled: Date?
    private var following: Task<Void, Never>?

    init(center: any WarningCenter, build: BuildLife? = nil, now: @escaping () -> Date = { Date() },
         clock: @escaping () -> HomeClock = { HomeClock.current.clock }) {
        self.center = center
        self.build = build
        self.now = now
        self.clock = clock
    }

    func expiry(warned: Date?, at now: Date) async -> Date? {
        guard let build, build.expires != warned else { return warned }
        let expires = build.expires
        let wait = build.notice.timeIntervalSince(now)
        do {
            try await center.post(id: Self.expiryID, body: Self.expiring(expires), after: wait > 0 ? wait : nil, sound: false)
            return expires
        } catch {
            return warned
        }
    }

    func follow(_ link: HomeLink) {
        following?.cancel()
        following = Task { [weak self] in
            for await snapshot in link.snapshots() {
                guard let self, !Task.isCancelled else { return }
                await self.reach(snapshot)
            }
        }
    }

    func reach(_ snapshot: HomeLink.ReachSnapshot) async {
        if snapshot.reach == .unpaired {
            scheduled = nil
            return center.remove([Self.silenceID])
        }
        guard let at = snapshot.lastReached, scheduled.map({ at.timeIntervalSince($0) >= 60 }) ?? true else { return }
        let fires = at.addingTimeInterval(Self.silence)
        let wait = fires.timeIntervalSince(now())
        guard wait > 0 else {
            scheduled = at
            return
        }
        do {
            try await center.post(id: Self.silenceID, body: ReachWords.stale(lastReached: at, clock: clock(), now: fires), after: wait, sound: false)
            scheduled = at
        } catch {}
    }

    static func expiring(_ expires: Date) -> String {
        "This build stops on \(Words.longDate(expires)) · Reinstall it from your Mac"
    }

    static func said(_ need: HomeLink.Need) -> String {
        [need.words, need.line].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    func show(_ needs: [HomeLink.Need], unit: String?, shown: [String: String]) async -> [String: String] {
        let mine = needs.filter { $0.banner || ($0.unit != nil && $0.unit == unit) }
        let since = { (need: HomeLink.Need) in need.sinceMs.map(String.init) ?? "" }
        for need in mine where shown[need.id] != since(need) {
            try? await center.post(id: "need:" + need.id, body: Self.said(need), after: nil, sound: false)
        }
        let showing = Dictionary(mine.map { ($0.id, since($0)) }) { first, _ in first }
        let dropped = Set(shown.keys).subtracting(showing.keys)
        if !dropped.isEmpty { center.remove(dropped.sorted().map { "need:" + $0 }) }
        return showing
    }
}

struct BuildLife: Equatable {
    let made: Date
    let expires: Date

    static let notice: TimeInterval = 14 * 86400

    var notice: Date {
        expires.addingTimeInterval(-min(Self.notice, max(0, expires.timeIntervalSince(made)) / 2))
    }
}

enum BuildExpiry {
    struct Unreadable: Error, CustomStringConvertible {
        let description: String
    }

    private static let log = Logger(subsystem: "org.lifestreamprotocol.phone", category: "shipping")

    static func read(_ bundle: Bundle = .main) -> BuildLife? {
        guard let url = bundle.url(forResource: "embedded", withExtension: "mobileprovision") else { return nil }
        do {
            return try life(profile: Data(contentsOf: url))
        } catch {
            log.error("The build's provisioning profile does not read: \(String(describing: error), privacy: .public)")
            return nil
        }
    }

    static func life(profile: Data) throws -> BuildLife {
        guard let start = profile.range(of: Data("<?xml".utf8)),
              let end = profile.range(of: Data("</plist>".utf8), in: start.lowerBound..<profile.endIndex) else {
            throw Unreadable(description: "no property list in the profile")
        }
        let list = try PropertyListSerialization.propertyList(from: profile[start.lowerBound..<end.upperBound], format: nil)
        guard let fields = list as? [String: Any], let made = fields["CreationDate"] as? Date,
              let expires = fields["ExpirationDate"] as? Date else {
            throw Unreadable(description: "the profile states no CreationDate or ExpirationDate")
        }
        return BuildLife(made: made, expires: expires)
    }
}

@MainActor
final class LocalWarnings: WarningCenter {
    static func requestAuthorization() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    }

    func post(id: String, body: String, after delay: TimeInterval?, sound: Bool) async throws {
        let content = UNMutableNotificationContent()
        content.title = "Lifestream"
        content.body = body
        content.sound = sound ? .default : nil
        let trigger = delay.map { UNTimeIntervalNotificationTrigger(timeInterval: max(1, $0), repeats: false) }
        try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: trigger))
    }

    func remove(_ ids: [String]) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ids)
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
    }
}
