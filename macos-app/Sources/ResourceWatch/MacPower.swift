import Foundation
import IOKit

public struct MacPowerSample: Equatable, Sendable {
    public var powerMW: Double?
    public var batteryPercent: Int?
    public var externalPower: Bool

    public init(powerMW: Double?, batteryPercent: Int?, externalPower: Bool) {
        self.powerMW = powerMW
        self.batteryPercent = batteryPercent
        self.externalPower = externalPower
    }

    public init?(_ value: (String) -> Any?) {
        guard let external = value("ExternalConnected") as? Bool else { return nil }
        externalPower = external
        if external {
            let telemetry = value("PowerTelemetryData") as? [String: Any]
            powerMW = (telemetry?["SystemLoad"] as? NSNumber).map { $0.doubleValue }
        } else if let volts = (value("Voltage") as? NSNumber)?.int64Value,
                  let amps = (value("InstantAmperage") as? NSNumber)?.int64Value {
            powerMW = Double(volts) * Double(max(0, -amps)) / 1000
        } else {
            powerMW = nil
        }
        if let current = (value("CurrentCapacity") as? NSNumber)?.doubleValue,
           let maximum = (value("MaxCapacity") as? NSNumber)?.doubleValue, maximum > 0 {
            batteryPercent = Int((current / maximum * 100).rounded())
        } else {
            batteryPercent = nil
        }
    }
}

public final class SmartBattery {
    private var service: io_service_t = 0

    public init() {}

    deinit {
        if service != 0 { IOObjectRelease(service) }
    }

    public func read() -> MacPowerSample? {
        if service == 0 {
            service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSmartBattery"))
            guard service != 0 else { return nil }
        }
        let entry = service
        return MacPowerSample { key in
            IORegistryEntryCreateCFProperty(entry, key as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue()
        }
    }
}
