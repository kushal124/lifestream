import CoreLocation
import Foundation
import UIKit

struct Fence: Codable, Equatable, Sendable {
    let latitude: Double
    let longitude: Double
    let radius: Double

    func matches(_ other: Fence) -> Bool {
        CLLocation(latitude: latitude, longitude: longitude)
            .distance(from: CLLocation(latitude: other.latitude, longitude: other.longitude)) <= 1
            && abs(radius - other.radius) <= 1
    }
}

@MainActor
protocol Geofences: AnyObject {
    var isProtectedDataAvailable: Bool { get }
    func open() async -> any GeofenceMonitor
}

@MainActor
protocol GeofenceMonitor: AnyObject {
    func add(_ fence: Fence, identifier: String) async
    func remove(_ identifier: String) async
    func condition(of identifier: String) async -> Fence?
    func listen(_ heard: (_ identifier: String, _ state: CLMonitor.Event.State) -> Void) async throws
}

@MainActor
final class SystemGeofences: Geofences {
    var isProtectedDataAvailable: Bool { UIApplication.shared.isProtectedDataAvailable }

    func open() async -> any GeofenceMonitor {
        SystemGeofenceMonitor(await CLMonitor("LifestreamCatchGeofence"))
    }
}

@MainActor
private final class SystemGeofenceMonitor: GeofenceMonitor {
    private let monitor: CLMonitor

    init(_ monitor: CLMonitor) { self.monitor = monitor }

    func add(_ fence: Fence, identifier: String) async {
        await monitor.add(
            CLMonitor.CircularGeographicCondition(
                center: .init(latitude: fence.latitude, longitude: fence.longitude), radius: fence.radius),
            identifier: identifier)
    }

    func remove(_ identifier: String) async {
        await monitor.remove(identifier)
    }

    func condition(of identifier: String) async -> Fence? {
        guard let circle = await monitor.record(for: identifier)?.condition
            as? CLMonitor.CircularGeographicCondition
        else { return nil }
        return Fence(latitude: circle.center.latitude, longitude: circle.center.longitude, radius: circle.radius)
    }

    func listen(_ heard: (String, CLMonitor.Event.State) -> Void) async throws {
        for try await event in await monitor.events {
            guard !Task.isCancelled else { return }
            heard(event.identifier, event.state)
        }
    }
}
