import Darwin
#if SCREEN_TIME
import DeviceActivity
import FamilyControls
#endif
import Foundation
import LifestreamCaptureCore

enum UsageMonitorSetupError: Error, LocalizedError {
    case missingAppGroup
    var errorDescription: String? {
        "Monitoring is unavailable in this build. Install a build with monitoring enabled, then try again."
    }
}

@MainActor
final class UsageMonitorManager {
    static let configurationName = "usage-monitor-configuration.json"

    func loadConfiguration() throws -> JSONValue? {
        try loadSharedJSON(name: Self.configurationName, maximumBytes: 131072)
    }

    func loadDiagnostic() throws -> JSONValue? {
        try loadSharedJSON(name: "usage-monitor-error.json", maximumBytes: 16384)
    }

    private func loadSharedJSON(name: String, maximumBytes: Int) throws -> JSONValue? {
        let url = try Self.directory().appendingPathComponent(name)
        guard let bytes = try FileDurability.readRegularFileIfPresent(at: url, maximumBytes: maximumBytes) else { return nil }
        return try JSONDecoder.lifestream().decode(JSONValue.self, from: bytes)
    }

    #if SCREEN_TIME
    func start(selection: FamilyActivitySelection, thresholdMinutes: Int) throws {
        guard (5...1440).contains(thresholdMinutes) else { throw CocoaError(.coderInvalidValue) }
        let id = UUID().uuidString
        let name = DeviceActivityName("usage-" + id)
        let eventName = DeviceActivityEvent.Name("selected-usage")
        let schedule = DeviceActivitySchedule(intervalStart: DateComponents(hour: 0, minute: 0), intervalEnd: DateComponents(hour: 23, minute: 59, second: 59), repeats: true, warningTime: DateComponents(minute: 1))
        let event = DeviceActivityEvent(applications: selection.applicationTokens, categories: selection.categoryTokens, webDomains: selection.webDomainTokens, threshold: DateComponents(minute: thresholdMinutes), includesPastActivity: false)
        let selectionJSON = try JSONDecoder.lifestream().decode(JSONValue.self, from: JSONEncoder.lifestream().encode(selection))
        let config: JSONValue = .object([
            "activity": .string(name.rawValue), "event": .string(eventName.rawValue),
            "selection": selectionJSON, "threshold": .object(["minute": .integer(Int64(thresholdMinutes))]),
            "includesPastActivity": .bool(event.includesPastActivity), "includesAllActivity": .bool(event.includesAllActivity),
            "schedule": .object(["intervalStart": .object(["hour": .integer(0), "minute": .integer(0)]), "intervalEnd": .object(["hour": .integer(23), "minute": .integer(59), "second": .integer(59)]), "repeats": .bool(true), "warningTime": .object(["minute": .integer(1)]), "timeZone": .string(TimeZone.current.identifier)]),
            "configuredAt": .string(CaptureTime.rfc3339(AppClock.now))
        ])
        let directory = try Self.directory()
        let bytes = try JSONEncoder.lifestream().encode(config)
        guard bytes.count <= 131072 else { throw UsageSourceError.oversized }
        try Self.publish(bytes, at: directory.appendingPathComponent(name.rawValue + ".json"))
        let center = DeviceActivityCenter()
        try center.startMonitoring(name, during: schedule, events: [eventName: event])
        center.stopMonitoring(center.activities.filter { $0.rawValue.hasPrefix("usage-") && $0 != name })
        try Self.publish(bytes, at: directory.appendingPathComponent(Self.configurationName))
    }

    func stop() throws {
        let center = DeviceActivityCenter()
        center.stopMonitoring(center.activities.filter { $0.rawValue.hasPrefix("usage-") })
        let url = try Self.directory().appendingPathComponent(Self.configurationName)
        try FileDurability.removeRegularFileIfPresentDurably(at: url)
    }
    #endif

    private static func publish(_ bytes: Data, at url: URL) throws {
        try bytes.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
        let descriptor = open(url.deletingLastPathComponent().path, O_RDONLY)
        guard descriptor >= 0 else { throw POSIXError(.EIO) }
        defer { close(descriptor) }
        guard fsync(descriptor) == 0 else { throw POSIXError(.EIO) }
    }

    private static func directory() throws -> URL {
        guard let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: AppGroup.identifier) else { throw UsageMonitorSetupError.missingAppGroup }
        return url
    }
}
