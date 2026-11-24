#if SCREEN_TIME
import DeviceActivity
import FamilyControls
import ManagedSettings
import SwiftUI
#endif
import Foundation
import LifestreamCaptureCore

enum UsageAuthorization: String, Sendable {
    case unsupported, notDetermined, denied, approved, approvedWithDataAccess, notInThisBuild
}

protocol UsageActivitySource: Sendable {
    func authorization() async -> UsageAuthorization
    func requestAuthorization() async throws
    func fetch(interval: DateInterval, live: Bool,
               onContext: @Sendable (JSONValue) async throws -> Void,
               onSegment: @Sendable (JSONValue, Date) async throws -> Void) async throws
    func catalog() async throws -> JSONValue
}

enum UsageSourceError: Error, LocalizedError {
    case unsupported, unauthorized, oversized, notInThisBuild
    var errorDescription: String? {
        switch self {
        case .notInThisBuild: "This build of Lifestream does not include Screen Time."
        case .unsupported: "Screen Time export requires iOS 26.4 or later."
        case .unauthorized: "Screen Time export requires Apple's expanded data authorization and provisioning."
        case .oversized: "The returned usage data exceeds the capture limit. This request is incomplete."
        }
    }
}

#if SCREEN_TIME
actor AppleUsageActivitySource: UsageActivitySource {
    func authorization() async -> UsageAuthorization {
        let status = AuthorizationCenter.shared.authorizationStatus
        if #available(iOS 26.4, *), status == .approvedWithDataAccess { return .approvedWithDataAccess }
        switch status {
        case .notDetermined: return .notDetermined
        case .denied: return .denied
        case .approved: return .approved
        default: return .unsupported
        }
    }

    func requestAuthorization() async throws {
        try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
    }

    func fetch(interval: DateInterval, live: Bool,
               onContext: @Sendable (JSONValue) async throws -> Void,
               onSegment: @Sendable (JSONValue, Date) async throws -> Void) async throws {
        guard #available(iOS 26.4, *) else { throw UsageSourceError.unsupported }
        guard await authorization() == .approvedWithDataAccess else { throw UsageSourceError.unauthorized }
        let filter = DeviceActivityFilter(segment: .hourly(during: interval))
        for try await data in DeviceActivityData.activityData(filteredBy: filter, using: live ? .live : .cached) {
            try Task.checkCancellation()
            let context: [String: JSONValue] = [
                "lastUpdatedDate": Self.date(data.lastUpdatedDate),
                "device": .object(["name": Self.optional(data.device.name), "model": .integer(Int64(data.device.model.rawValue))]),
                "user": .object(["role": .integer(Int64(data.user.role.rawValue)), "accountIdentifiersOmitted": .bool(true)]),
                "segmentInterval": Self.segmentInterval(data.segmentInterval),
                "filter": .object(["device": .string("current"), "user": .string("current"), "applications": .array([]), "categories": .array([]), "webDomains": .array([])]),
                "osVersion": .string(ProcessInfo.processInfo.operatingSystemVersionString),
                "sdk": Self.optional(Bundle.main.object(forInfoDictionaryKey: "DTSDKName") as? String),
                "xcodeBuild": Self.optional(Bundle.main.object(forInfoDictionaryKey: "DTXcodeBuild") as? String)
            ]
            try await onContext(.object(context))
            for await segment in data.activitySegments {
                try Task.checkCancellation()
                var categories: [JSONValue] = []
                var remaining = 3 * 1024 * 1024
                for await category in segment.categories {
                    var apps: [JSONValue] = []
                    var domains: [JSONValue] = []
                    for await app in category.applications {
                        try Task.checkCancellation()
                        let value: JSONValue = .object([
                            "application": try Self.application(app.application),
                            "totalActivityDuration": .number(app.totalActivityDuration),
                            "numberOfPickups": .integer(Int64(app.numberOfPickups)),
                            "numberOfNotifications": .integer(Int64(app.numberOfNotifications))
                        ])
                        try Self.consume(value, remaining: &remaining)
                        apps.append(value)
                    }
                    for await domain in category.webDomains {
                        try Task.checkCancellation()
                        let value: JSONValue = .object(["webDomain": try Self.domain(domain.webDomain), "totalActivityDuration": .number(domain.totalActivityDuration)])
                        try Self.consume(value, remaining: &remaining)
                        domains.append(value)
                    }
                    let identity = try Self.category(category.category)
                    try Self.consume(identity, remaining: &remaining)
                    remaining -= 256
                    guard remaining >= 0 else { throw UsageSourceError.oversized }
                    categories.append(.object(["category": identity, "totalActivityDuration": .number(category.totalActivityDuration), "applications": .array(try Self.sorted(apps)), "webDomains": .array(try Self.sorted(domains))]))
                }
                var result = context
                result["dateInterval"] = Self.interval(segment.dateInterval)
                result["totalActivityDuration"] = .number(segment.totalActivityDuration)
                result["longestActivity"] = segment.longestActivity.map(Self.interval) ?? .null
                result["firstPickup"] = segment.firstPickup.map(Self.date) ?? .null
                result["totalPickupsWithoutApplicationActivity"] = .integer(Int64(segment.totalPickupsWithoutApplicationActivity))
                result["categories"] = .array(try Self.sorted(categories))
                let value = JSONValue.object(result)
                guard try JSONEncoder.lifestream().encode(value).count <= 3 * 1024 * 1024 else { throw UsageSourceError.oversized }
                try await onSegment(value, segment.dateInterval.start)
            }
        }
    }

    nonisolated func catalog() async throws -> JSONValue {
        guard #available(iOS 26.4, *) else { throw UsageSourceError.unsupported }
        guard await authorization() == .approvedWithDataAccess else { throw UsageSourceError.unauthorized }
        var result: [String: JSONValue] = [:]
        var budget = 3 * 1024 * 1024
        do {
            let items = try await FamilyActivityData.shared.installedApplications
            result["installedApplications"] = try Self.collection(items, remaining: &budget, transform: Self.application)
        } catch is CancellationError { throw CancellationError() }
        catch { result["installedApplications"] = Self.failure(error) }
        try Task.checkCancellation()
        do {
            let items = try await FamilyActivityData.shared.visitedWebDomains
            result["visitedWebDomains"] = try Self.collection(items, remaining: &budget, transform: Self.domain)
        } catch is CancellationError { throw CancellationError() }
        catch { result["visitedWebDomains"] = Self.failure(error) }
        try Task.checkCancellation()
        do {
            let items = try await FamilyActivityData.shared.activityCategories
            result["activityCategories"] = try Self.collection(items, remaining: &budget, transform: Self.category)
        } catch is CancellationError { throw CancellationError() }
        catch { result["activityCategories"] = Self.failure(error) }
        result["complete"] = .bool(result.values.allSatisfy { value in
            guard case .object(let part) = value else { return false }; return part["status"] == .string("success")
        })
        return .object(result)
    }

    nonisolated static func collection<S: Sequence>(_ source: S, remaining: inout Int, transform: (S.Element) throws -> JSONValue) throws -> JSONValue {
        var values: [(Data, JSONValue)] = []
        var projectedRemaining = remaining
        for item in source {
            try Task.checkCancellation()
            let value = try transform(item)
            let bytes = try JSONEncoder.lifestream().encode(value)
            projectedRemaining -= bytes.count + 1
            guard projectedRemaining >= 0 else { throw UsageSourceError.oversized }
            values.append((bytes, value))
        }
        values.sort { $0.0.lexicographicallyPrecedes($1.0) }
        remaining = projectedRemaining
        return .object(["status": .string("success"), "values": .array(values.map(\.1))])
    }
    nonisolated private static func sorted(_ values: [JSONValue]) throws -> [JSONValue] {
        try values.map { (try JSONEncoder.lifestream().encode($0), $0) }
            .sorted { $0.0.lexicographicallyPrecedes($1.0) }.map(\.1)
    }
    nonisolated private static func consume(_ value: JSONValue, remaining: inout Int) throws {
        remaining -= try JSONEncoder.lifestream().encode(value).count + 1
        guard remaining >= 0 else { throw UsageSourceError.oversized }
    }
    nonisolated private static func token<T: Encodable>(_ token: T?) throws -> JSONValue {
        guard let token else { return .null }
        return .object(["encoding": .string("json-base64"), "value": .string(try JSONEncoder.lifestream().encode(token).base64EncodedString())])
    }
    nonisolated private static func application(_ value: Application) throws -> JSONValue {
        .object(["bundleIdentifier": optional(value.bundleIdentifier), "localizedDisplayName": optional(value.localizedDisplayName), "token": try token(value.token)])
    }
    nonisolated private static func domain(_ value: WebDomain) throws -> JSONValue {
        .object(["domain": optional(value.domain), "token": try token(value.token)])
    }
    nonisolated private static func category(_ value: ActivityCategory) throws -> JSONValue {
        .object(["localizedDisplayName": optional(value.localizedDisplayName), "token": try token(value.token)])
    }
    nonisolated private static func optional(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }
    nonisolated private static func date(_ value: Date) -> JSONValue {
        .object(["epochSeconds": .number(value.timeIntervalSince1970), "rfc3339": .string(CaptureTime.rfc3339(value))])
    }
    nonisolated private static func interval(_ value: DateInterval) -> JSONValue {
        .object(["start": date(value.start), "end": date(value.end)])
    }
    nonisolated private static func segmentInterval(_ value: DeviceActivityFilter.SegmentInterval) -> JSONValue {
        switch value {
        case .hourly(let interval): return .object(["kind": .string("hourly"), "during": Self.interval(interval)])
        case .daily(let interval): return .object(["kind": .string("daily"), "during": Self.interval(interval)])
        case .weekly(let interval): return .object(["kind": .string("weekly"), "during": Self.interval(interval)])
        @unknown default: return .object(["kind": .string("unknown")])
        }
    }
    nonisolated private static func failure(_ error: any Error) -> JSONValue {
        let ns = error as NSError
        return .object(["status": .string("failed"), "error": .object(["domain": .string(ns.domain), "code": .integer(Int64(ns.code)), "description": .string(ns.localizedDescription)])])
    }
}
#else
struct NoScreenTimeUsageSource: UsageActivitySource {
    func authorization() async -> UsageAuthorization { .notInThisBuild }
    func requestAuthorization() async throws { throw UsageSourceError.notInThisBuild }
    func fetch(interval: DateInterval, live: Bool,
               onContext: @Sendable (JSONValue) async throws -> Void,
               onSegment: @Sendable (JSONValue, Date) async throws -> Void) async throws {
        throw UsageSourceError.notInThisBuild
    }
    func catalog() async throws -> JSONValue { throw UsageSourceError.notInThisBuild }
}
#endif
