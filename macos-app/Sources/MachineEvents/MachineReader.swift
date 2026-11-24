import AppKit
import CoreWLAN
import Foundation
import IOKit
import IOKit.ps
import IOKit.pwr_mgt

enum MachineReader {
    struct Power {
        let source: MachinePower
        let percent: Double?
    }

    struct WiFi {
        let joined: Bool
        let name: String?
        let nameUnavailable: Bool
    }

    static func state() -> MachineState {
        let session = CGSessionCopyCurrentDictionary() as? [String: Any]
        let power = power()
        let wifi = wifi()
        return MachineState(
            awake: true,
            displayAwake: CGDisplayIsAsleep(CGMainDisplayID()) == 0,
            sessionActive: session?[kCGSessionOnConsoleKey as String] as? Bool ?? true,
            locked: session?["CGSSessionScreenIsLocked"] as? Bool ?? false,
            power: power.source,
            batteryPercent: power.percent,
            lidOpen: lidOpen(),
            wifiJoined: wifi.joined,
            wifiName: wifi.name,
            wifiNameUnavailable: wifi.nameUnavailable)
    }

    static func lidOpen() -> Bool? {
        let service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }
        let property = IORegistryEntryCreateCFProperty(service, "AppleClamshellState" as CFString,
                                                       kCFAllocatorDefault, 0)
        guard let closed = property?.takeRetainedValue() as? Bool else { return nil }
        return !closed
    }

    static func power() -> Power {
        guard let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue() else {
            return Power(source: .unknown, percent: nil)
        }
        let providing = IOPSGetProvidingPowerSourceType(blob)?.takeUnretainedValue() as String?
        let source: MachinePower
        switch providing {
        case kIOPMACPowerKey: source = .ac
        case kIOPMBatteryPowerKey: source = .battery
        default: source = .unknown
        }
        var percent: Double?
        if let list = IOPSCopyPowerSourcesList(blob)?.takeRetainedValue() as? [CFTypeRef] {
            for entry in list {
                guard let description = IOPSGetPowerSourceDescription(blob, entry)?
                    .takeUnretainedValue() as? [String: Any],
                    let current = description[kIOPSCurrentCapacityKey] as? Double,
                    let capacity = description[kIOPSMaxCapacityKey] as? Double,
                    capacity > 0 else { continue }
                percent = (current / capacity * 100).rounded()
                break
            }
        }
        return Power(source: source, percent: percent)
    }

    static func wifi() -> WiFi {
        guard let interface = CWWiFiClient.shared().interface(), interface.powerOn() else {
            return WiFi(joined: false, name: nil, nameUnavailable: false)
        }
        let joined = interface.interfaceMode() != CWInterfaceMode.none
        guard joined else { return WiFi(joined: false, name: nil, nameUnavailable: false) }
        let name = interface.ssid()
        return WiFi(joined: true, name: name, nameUnavailable: name == nil)
    }
}
