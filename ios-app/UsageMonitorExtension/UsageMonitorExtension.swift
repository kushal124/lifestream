import DeviceActivity
import Foundation
import LifestreamCaptureCore
import OSLog

final class UsageMonitorExtension: DeviceActivityMonitor {
    override func intervalDidStart(for activity: DeviceActivityName) { record("intervalDidStart", activity: activity) }
    override func intervalDidEnd(for activity: DeviceActivityName) { record("intervalDidEnd", activity: activity) }
    override func intervalWillStartWarning(for activity: DeviceActivityName) { record("intervalWillStartWarning", activity: activity) }
    override func intervalWillEndWarning(for activity: DeviceActivityName) { record("intervalWillEndWarning", activity: activity) }
    override func eventDidReachThreshold(_ event: DeviceActivityEvent.Name, activity: DeviceActivityName) { record("eventDidReachThreshold", activity: activity, event: event) }
    override func eventWillReachThresholdWarning(_ event: DeviceActivityEvent.Name, activity: DeviceActivityName) { record("eventWillReachThresholdWarning", activity: activity, event: event) }

    private func record(_ kind: String, activity: DeviceActivityName, event: DeviceActivityEvent.Name? = nil) {
        let delivered = Date()
        do {
            guard let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: AppGroup.identifier) else { throw CocoaError(.fileNoSuchFile) }
            var configuration: JSONValue = .null
            var configurationError: JSONValue = .null
            do {
                guard activity.rawValue.hasPrefix("usage-"), UUID(uuidString: String(activity.rawValue.dropFirst(6))) != nil else { throw CocoaError(.fileReadInvalidFileName) }
                let url = root.appendingPathComponent(activity.rawValue + ".json")
                guard let bytes = try FileDurability.readRegularFileIfPresent(at: url, maximumBytes: 131072) else { throw CocoaError(.fileNoSuchFile) }
                configuration = try JSONDecoder.lifestream().decode(JSONValue.self, from: bytes)
            } catch { configurationError = .string(error.localizedDescription) }
            let payload: JSONValue = .object([
                "observed_at": .string(CaptureTime.rfc3339(delivered)), "callback": .string(kind), "activity": .string(activity.rawValue), "event": event.map { .string($0.rawValue) } ?? .null,
                "deliveredAt": .object(["epochSeconds": .number(delivered.timeIntervalSince1970), "rfc3339": .string(CaptureTime.rfc3339(delivered))]),
                "configuration": configuration, "configurationError": configurationError
            ])
            _ = try UsageInbox(directory: root.appendingPathComponent("usage-inbox", isDirectory: true)).publish(payload)
        } catch {
            if let root = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: AppGroup.identifier) {
                let diagnostic: JSONValue = .object(["best_effort": .bool(true), "observed_at": .string(CaptureTime.rfc3339(delivered)), "callback": .string(kind), "activity": .string(activity.rawValue), "event": event.map { .string($0.rawValue) } ?? .null, "error": .string(error.localizedDescription)])
                if let bytes = try? JSONEncoder.lifestream().encode(diagnostic) {
                    let url = root.appendingPathComponent("usage-monitor-error.json")
                    do {
                        try bytes.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                        try FileDurability.synchronizeFile(at: url)
                        try FileDurability.synchronizeParentDirectory(of: url)
                    } catch {
                        Logger(subsystem: "org.lifestreamprotocol.phone", category: "usage-monitor").error("Usage diagnostic could not be persisted: \(error.localizedDescription, privacy: .private)")
                    }
                }
            }
            Logger(subsystem: "org.lifestreamprotocol.phone", category: "usage-monitor").error("Usage callback could not be persisted: \(error.localizedDescription, privacy: .private)")
        }
    }
}
