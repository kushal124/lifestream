import Foundation

enum PeripheralEvents {
    static let lightInterval: TimeInterval = 30

    static func displays(from held: [DisplayFacts]?, to next: [DisplayFacts]?, at: Date) -> [MachineEvent] {
        guard let held, let next else { return [] }
        let before = Dictionary(held.map { ($0.id, $0) }) { first, _ in first }
        let after = Dictionary(next.map { ($0.id, $0) }) { first, _ in first }
        var events: [MachineEvent] = []
        for id in before.keys.sorted() where after[id] == nil {
            events.append(MachineEvent(at: at, name: .displayDetach, detail: displayDetail(before[id]!)))
        }
        for id in after.keys.sorted() where before[id] == nil {
            events.append(MachineEvent(at: at, name: .displayAttach, detail: displayDetail(after[id]!)))
        }
        for id in after.keys.sorted() {
            guard let old = before[id], let new = after[id], !new.sameArrangement(as: old) else { continue }
            events.append(MachineEvent(at: at, name: .displayChange, detail: displayDetail(new)))
        }
        return events
    }

    static func bluetooth(connected: Bool, _ device: BluetoothFacts, held: [BluetoothFacts]?,
                          at: Date) -> (held: [BluetoothFacts], events: [MachineEvent]) {
        let unread = held == nil
        var devices = held ?? []
        let index = devices.firstIndex { $0.identity == device.identity }
        if connected {
            guard index == nil else { return (devices, []) }
            devices.append(device)
            return (devices, [MachineEvent(at: at, name: .bluetoothConnect, detail: bluetoothDetail(device))])
        }
        if let index { devices.remove(at: index) } else if !unread { return (devices, []) }
        return (devices, [MachineEvent(at: at, name: .bluetoothDisconnect, detail: bluetoothDetail(device))])
    }

    static func stateDetail(_ peripherals: Peripherals?) -> [String: MachineEventValue] {
        var detail: [String: MachineEventValue] = [:]
        if let displays = peripherals?.displays {
            detail["displays"] = .number(Double(displays.count))
            let names = displays.compactMap(\.name).sorted()
            if !names.isEmpty { detail["display_names"] = .text(names.joined(separator: ", ")) }
        } else {
            detail["displays_unavailable"] = .flag(true)
        }
        if let bluetooth = peripherals?.bluetooth {
            detail["bluetooth_connected"] = .number(Double(bluetooth.count))
            let names = bluetooth.compactMap(\.name).sorted()
            if !names.isEmpty { detail["bluetooth_names"] = .text(names.joined(separator: ", ")) }
        } else {
            detail["bluetooth_unavailable"] = .flag(true)
        }
        if let lux = peripherals?.lux {
            detail["ambient_lux"] = .number(lux)
        } else {
            detail["ambient_light_unavailable"] = .flag(true)
        }
        return detail
    }


    static func displayDetail(_ display: DisplayFacts) -> [String: MachineEventValue] {
        var detail: [String: MachineEventValue] = [
            "display": .number(Double(display.id)), "built_in": .flag(display.builtIn), "main": .flag(display.main),
            "x": .number(display.x), "y": .number(display.y),
            "width": .number(display.width), "height": .number(display.height),
        ]
        if let name = display.name { detail["name"] = .text(name) } else { detail["name_unavailable"] = .flag(true) }
        if let width = display.pixelWidth, let height = display.pixelHeight {
            detail["pixel_width"] = .number(Double(width))
            detail["pixel_height"] = .number(Double(height))
        } else {
            detail["pixel_size_unavailable"] = .flag(true)
        }
        if let width = display.widthMM, let height = display.heightMM {
            detail["width_mm"] = .number(width)
            detail["height_mm"] = .number(height)
        } else {
            detail["physical_size_unavailable"] = .flag(true)
        }
        if let mirrored = display.mirrorOf { detail["mirror_of"] = .number(Double(mirrored)) }
        return detail
    }

    static func bluetoothDetail(_ device: BluetoothFacts) -> [String: MachineEventValue] {
        var detail: [String: MachineEventValue] = ["class_of_device": .number(Double(device.classOfDevice))]
        if let address = device.address { detail["address"] = .text(address) } else { detail["address_unavailable"] = .flag(true) }
        if let name = device.name { detail["name"] = .text(name) } else { detail["name_unavailable"] = .flag(true) }
        guard device.classOfDevice != 0 else { return detail }
        let major = Int((device.classOfDevice >> 8) & 0x1F)
        let minor = Int((device.classOfDevice >> 2) & 0x3F)
        if let word = majorClasses[major] { detail["major"] = .text(word) }
        if let word = minorClass(major: major, minor: minor) { detail["minor"] = .text(word) }
        return detail
    }

    private static let majorClasses: [Int: String] = [
        0: "miscellaneous", 1: "computer", 2: "phone", 3: "network", 4: "audio_video", 5: "peripheral",
        6: "imaging", 7: "wearable", 8: "toy", 9: "health", 31: "uncategorized",
    ]

    private static let minorClasses: [Int: [Int: String]] = [
        1: [1: "desktop", 2: "server", 3: "laptop", 4: "handheld", 5: "palm", 6: "wearable", 7: "tablet"],
        2: [1: "cellular", 2: "cordless", 3: "smartphone", 4: "modem", 5: "isdn"],
        4: [1: "headset", 2: "hands_free", 4: "microphone", 5: "loudspeaker", 6: "headphones", 7: "portable_audio",
            8: "car_audio", 9: "set_top_box", 10: "hifi_audio", 11: "vcr", 12: "video_camera", 13: "camcorder",
            14: "video_monitor", 15: "video_display_and_loudspeaker", 16: "video_conferencing", 18: "gaming_toy"],
        7: [1: "wristwatch", 2: "pager", 3: "jacket", 4: "helmet", 5: "glasses"],
    ]

    private static let peripheralKinds: [Int: String] = [1: "keyboard", 2: "pointing", 3: "keyboard+pointing"]
    private static let peripheralTypes: [Int: String] = [
        1: "joystick", 2: "gamepad", 3: "remote_control", 4: "sensing_device", 5: "digitizer_tablet",
        6: "card_reader", 7: "digital_pen", 8: "handheld_scanner", 9: "handheld_gestural_input",
    ]

    private static func minorClass(major: Int, minor: Int) -> String? {
        guard major == 5 else { return minorClasses[major]?[minor] }
        let words = [peripheralKinds[minor >> 4], peripheralTypes[minor & 0xF]].compactMap { $0 }
        return words.isEmpty ? nil : words.joined(separator: "+")
    }
}

struct LightRule: Equatable, Sendable {
    static let factor = 2.0
    static let floor = 10.0

    private(set) var stated: Double?
    private var pending: Double?

    init(stated: Double?) {
        self.stated = stated
    }

    mutating func read(_ lux: Double?, uncovered: Bool, at: Date) -> MachineEvent? {
        guard uncovered, let lux, isChange(lux) else {
            pending = nil
            return nil
        }
        guard pending != nil else {
            pending = lux
            return nil
        }
        pending = nil
        stated = lux
        return MachineEvent(at: at, name: .ambientLight, detail: ["lux": .number(lux)])
    }

    private func isChange(_ lux: Double) -> Bool {
        guard let stated else { return true }
        let ratio = max(lux, Self.floor) / max(stated, Self.floor)
        return ratio >= Self.factor || ratio <= 1 / Self.factor
    }
}
