import CoreLocation
import Foundation
import LifestreamCaptureCore

enum RawLocation {
    static func payload(
        _ location: CLLocation,
        acquisitionPath: String,
        engine: String,
        configuration: RequestedLocationConfiguration,
        receipt: WallAndMonotonicTime,
        batchID: UUID,
        batchIndex: Int,
        batchCount: Int
    ) -> JSONValue {
        var source: [String: JSONValue] = [
            "is_simulated_by_software": .null,
            "is_produced_by_accessory": .null,
        ]
        if let info = location.sourceInformation {
            source["is_simulated_by_software"] = .bool(info.isSimulatedBySoftware)
            source["is_produced_by_accessory"] = .bool(info.isProducedByAccessory)
        }
        let floor: JSONValue = location.floor.map { .integer(Int64($0.level)) } ?? .null
        let context: [String: JSONValue] = [
            "acquisition_path": .string(acquisitionPath),
            "engine": .string(engine),
            "requested_configuration": .object(configuration.json),
            "callback_receipt": .object([
                "wall_rfc3339": .string(receipt.wallRFC3339),
                "wall_unix_seconds": .number(receipt.wallUnixSeconds),
                "elapsed_seconds": .number(receipt.elapsedSeconds),
            ]),
            "batch_id": .string(batchID.uuidString.lowercased()),
            "batch_position": .integer(Int64(batchIndex)),
            "batch_count": .integer(Int64(batchCount)),
            "diagnostics": .object([:]),
            "stationary": .null,
        ]

        return .object([
            "location": .object([
                "timestamp_rfc3339_utc": .string(CaptureTime.rfc3339(location.timestamp)),
                "timestamp_unix_seconds": .number(location.timestamp.timeIntervalSince1970),
                "latitude": .number(location.coordinate.latitude),
                "longitude": .number(location.coordinate.longitude),
                "horizontal_accuracy": .number(location.horizontalAccuracy),
                "altitude": .number(location.altitude),
                "ellipsoidal_altitude": .number(location.ellipsoidalAltitude),
                "vertical_accuracy": .number(location.verticalAccuracy),
                "speed": .number(location.speed),
                "speed_accuracy": .number(location.speedAccuracy),
                "course": .number(location.course),
                "course_accuracy": .number(location.courseAccuracy),
                "floor": floor,
                "source_information": .object(source),
            ]),
            "capture_context": .object(context),
        ])
    }
}
