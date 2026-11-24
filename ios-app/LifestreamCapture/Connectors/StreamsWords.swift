import Cockpit
import Foundation
import HomeLink
import LifestreamCaptureCore

enum StreamsWords {
    struct Kind: Hashable {
        let key: String
        let name: String
        let icon: Cockpit.Icon?

        init(key: String, name: String, icon: Cockpit.Icon?) {
            self.key = key
            self.name = name
            self.icon = icon
        }

        init(_ type: HomeLink.Connector.Kind) {
            self.init(key: type.key, name: type.name, icon: Cockpit.Icon(rawValue: type.icon))
        }
    }

    struct Place: Equatable {
        let icon: Cockpit.Icon
        let word: String

        static let phone = Place(icon: .phoneScreen, word: "iPhone")
    }

    static let page = "Connectors"
    static let imports = "Imports"
    static let importsKey = "imports"
    static let search = "Search connectors"
    static let copied = "Copied"
    static let none = "No connectors match."
    static let start = "Start with these"
    static let connected = "Connected"
    static let notConnected = "Not connected"
    static let noneConnected = "Nothing connected yet."
    static let more = "More"
    static let home = "Lifestream"
    static let devices = "Devices"

    enum Pair {
        static let title = "Pair with your Mac"
        static let line = "What this iPhone records waits here."
        static let button = "Pair"
    }

    static let act = "On your Mac."

    enum Entry {
        static let name = "Not here?"
        static let line = "Your coding agent can build it on your Mac."
        static let title = "Add it with your coding agent"
        static let ask = "Paste this into your coding agent on your Mac."
        static let copy = "Copy line"
    }


    static func kind(_ connector: HomeLink.Connector) -> Kind? {
        connector.type.map(Kind.init)
    }

    static func icon(_ connector: HomeLink.Connector) -> Cockpit.Icon {
        Cockpit.Icon(rawValue: connector.icon) ?? .recording
    }

    static func place(_ connector: HomeLink.Connector) -> Place? {
        switch [HomeLink.Road.mac, .phone, .chrome, .poll, .upload].first(where: connector.roads.contains) {
        case .mac: Place(icon: .workMac, word: "Mac")
        case .phone: .phone
        case .chrome: Place(icon: .web, word: connector.browser?.name ?? "Chrome")
        case .poll: Place(icon: .online, word: "Online")
        case .upload: Place(icon: .file, word: "File")
        default: nil
        }
    }

    static func meta(_ connector: HomeLink.Connector) -> String? {
        guard let figure = connector.figure else { return connector.records.isEmpty ? nil : connector.records }
        let today = figure.today.map { count -> String in
            let named = noun(connector).map { " " + (count == 1 ? $0.0 : $0.1) } ?? ""
            return count == 0 && !named.isEmpty ? "No" + named + " today" : Words.count(count) + named + " today"
        }
        return [today, figure.words.isEmpty ? nil : figure.words].compactMap { $0 }.joined(separator: Words.dot)
    }

    static func line(_ connector: HomeLink.Connector) -> String? {
        connector.health.state == .setup ? connector.gives : meta(connector)
    }

    static func noun(_ connector: HomeLink.Connector) -> (String, String)? {
        guard let noun = connector.noun, noun.count == 2 else { return nil }
        return (noun[0], noun[1])
    }


    static func icon(_ device: HomeLink.DeviceRow) -> Cockpit.Icon {
        device.kind == .mac ? .workMac : .phoneScreen
    }


    static func daysEnding(_ day: String, count: Int) -> [String] {
        (0..<count).map { index in
            let each = Words.shiftDay(day, index - count + 1)
            return Words.shortDay(each, today: each)
        }
    }

    static func counted(_ count: Int) -> String {
        "\(Words.count(count)) connector\(count == 1 ? "" : "s")"
    }
}

extension HomeLink.State {
    var signal: Cockpit.SignalKind? {
        let shape = Cockpit.HealthState(rawValue: rawValue)?.signal
        return shape == .caution ? .idle : shape
    }

    var rowSignal: Cockpit.SignalKind? {
        signal == .warning ? .warning : nil
    }

    var rowMark: RowEnd.Face? {
        switch self {
        case .needsYou: .state(.caution, "Needs you")
        case .broken: .state(.warning, "Stopped")
        case .paused: .state(.idle, "Paused")
        case .waiting: .state(.idle, "Waiting")
        case .off: .state(.idle, "Off")
        case .setup, .quiet, .syncing, .ok: nil
        }
    }
}

extension HomeLink.Connector.Processing.Shape {
    var signal: Cockpit.SignalKind? {
        let state: HomeLink.State = switch self {
        case .off: .off
        case .needs: .needsYou
        case .waiting: .waiting
        case .running: .syncing
        case .done: .ok
        }
        return state.signal
    }
}

extension HomeLink.Act {
    func taken(by unit: String?, on connector: HomeLink.Connector? = nil) -> Bool {
        switch `do` {
        case .try, .skip, .read, .ignore, .open, .copy, .verify, .refresh, .signin, .import, .letGo, .report: true
        case .set: connector?.form.contains { $0.key == member } == true
        case .grant: self.unit != nil && self.unit == unit
        case .turn, .pair, .extension, .upload, .install, .storage, .browser, .vault: false
        }
    }

    var opensPage: Bool { `do` == .signin || `do` == .set || `do` == .import }
}

extension HomeLink.Need {
    var heldBack: [String] { streams ?? connector.map { [$0] } ?? [] }
}

struct DeviceLine: Identifiable {
    let id: String
    let name: String
    let icon: Cockpit.Icon
    let line: String
    let signal: Cockpit.SignalKind?

    static let reading = [
        DeviceLine(id: "extension", name: "Chrome extension", icon: .web, line: "Running in Chrome", signal: nil),
    ]

    static func all(_ report: HomeLink.StreamsReport, besides unit: String?) -> [DeviceLine] {
        report.devices.filter { $0.unit != unit && !$0.retired }.map(line) + [
            DeviceLine(id: "extension", name: report.extension.name, icon: .web, line: report.extension.health.words,
                       signal: report.extension.health.state.rowSignal),
        ]
    }

    static func removed(_ report: HomeLink.StreamsReport, besides unit: String?) -> [DeviceLine] {
        report.devices.filter { $0.unit != unit && $0.retired }.map(line)
    }

    private static func line(_ device: HomeLink.DeviceRow) -> DeviceLine {
        DeviceLine(id: device.unit, name: device.name, icon: StreamsWords.icon(device), line: device.health.words,
                   signal: device.health.state.rowSignal)
    }
}
