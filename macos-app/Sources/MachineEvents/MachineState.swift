import Evidence
import Foundation

enum MachinePower: String, Sendable {
    case ac
    case battery
    case unknown
}

struct MachineState: Equatable, Sendable {
    var awake: Bool
    var displayAwake: Bool
    var sessionActive: Bool
    var locked: Bool
    var power: MachinePower
    var batteryPercent: Double?
    var lidOpen: Bool?
    var wifiJoined: Bool
    var wifiName: String?
    var wifiNameUnavailable: Bool
    var devices: DeviceUse?
    var peripherals: Peripherals?
    var access: [String: String]

    init(awake: Bool = true,
                displayAwake: Bool = true,
                sessionActive: Bool = true,
                locked: Bool = false,
                power: MachinePower = .unknown,
                batteryPercent: Double? = nil,
                lidOpen: Bool? = nil,
                wifiJoined: Bool = false,
                wifiName: String? = nil,
                wifiNameUnavailable: Bool = false,
                devices: DeviceUse? = nil,
                peripherals: Peripherals? = nil,
                access: [String: String] = [:]) {
        self.awake = awake
        self.displayAwake = displayAwake
        self.sessionActive = sessionActive
        self.locked = locked
        self.power = power
        self.batteryPercent = batteryPercent
        self.lidOpen = lidOpen
        self.wifiJoined = wifiJoined
        self.wifiName = wifiName
        self.wifiNameUnavailable = wifiNameUnavailable
        self.devices = devices
        self.peripherals = peripherals
        self.access = access
    }

    var detail: [String: MachineEventValue] {
        var detail: [String: MachineEventValue] = [
            "awake": .flag(awake),
            "display_awake": .flag(displayAwake),
            "session_active": .flag(sessionActive),
            "locked": .flag(locked),
            "power": .text(power.rawValue),
            "wifi_joined": .flag(wifiJoined),
        ]
        if let batteryPercent {
            detail["battery_percent"] = .number(batteryPercent)
        } else {
            detail["battery_percent_unavailable"] = .flag(true)
        }
        if let lidOpen {
            detail["lid_open"] = .flag(lidOpen)
        } else {
            detail["lid_unavailable"] = .flag(true)
        }
        if let wifiName { detail["wifi_name"] = .text(wifiName) }
        if wifiNameUnavailable { detail["name_unavailable"] = .flag(true) }
        detail.merge(DeviceUseEvents.stateDetail(devices)) { held, _ in held }
        detail.merge(PeripheralEvents.stateDetail(peripherals)) { held, _ in held }
        for (grant, allowed) in access { detail["access_\(grant)"] = .text(allowed) }
        return detail
    }
}
