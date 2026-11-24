import Foundation
import HomeLink

public struct StreamsAnswer: PageAnswer {
    public static let route = HomeLink.Pages.Connectors.route

    public let page: HomeLink.Pages.Connectors
    public let report: HomeLink.StreamsReport
    private let callouts: [String: [String]]

    public var position: String { page.position }

    private struct Callouts: Decodable {
        let connectors: [Callout]

        struct Callout: Decodable {
            let id: String
            let callout: [Held]
        }

        struct Held: Decodable {
            let id: String
        }
    }

    public init(from decoder: Decoder) throws {
        page = try HomeLink.Pages.Connectors(from: decoder)
        report = try HomeLink.StreamsReport(from: decoder)
        callouts = Dictionary(try Callouts(from: decoder).connectors.map { ($0.id, $0.callout.map(\.id)) }) { first, _ in first }
    }

    public static func key(unit: String?) -> HomeLink.PageKey {
        HomeLink.PageKey(route, unit.map { ["unit": $0] } ?? [:])
    }

    public func lead(of row: HomeLink.Pages.StreamRow) -> HomeLink.Connector? {
        let members = row.ids.compactMap { id in report.connectors.first { $0.id == id } }
        return members.first { $0.health.state.rawValue == row.health.state.rawValue } ?? members.first
    }

    public func callout(of connector: String) -> [HomeLink.Need] {
        (callouts[connector] ?? []).compactMap { id in report.needs.first { $0.id == id } }
    }
}

extension HomeLink.Pages.When {
    public var phrased: HomeLink.Phrase.When? {
        switch self {
        case .day(let day): .day(day)
        case .month(let month): .month(month)
        case .at(let ms): .at(Int64(ms))
        case .clock(let ms): .clock(Int64(ms))
        case .unknown: nil
        }
    }
}

public enum StreamsLine {
    public static func words(_ row: HomeLink.Pages.StreamRow, clock: HomeClock = HomeClock.current.clock, now: Date = AppClock.now) -> String {
        let timed = row.time.flatMap(\.phrased).map { Words.lineWhen($0, clock: clock, now: now) }
        let head = [row.line, timed].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        return ([head] + row.more).filter { !$0.isEmpty }.joined(separator: Words.dot)
    }

    public static func last(_ row: HomeLink.Pages.StreamRow, clock: HomeClock = HomeClock.current.clock, now: Date = AppClock.now) -> String? {
        row.last.flatMap(\.phrased).map { Words.lineWhen($0, clock: clock, now: now) }
    }
}

extension HomeLink.Pages.Act {
    public var label: String {
        switch self {
        case .try(let label, _), .skip(let label, _), .letGo(let label, _), .import(let label, _), .read(let label, _, _),
             .ignore(let label, _, _), .turn(let label, _), .signin(let label, _), .refresh(let label, _), .resume(let label, _),
             .set(let label, _), .grant(let label, _, _), .open(let label, _), .copy(let label, _), .browser(let label, _),
             .pair(let label), .extension(let label), .upload(let label), .install(let label), .storage(let label),
             .vault(let label), .verify(let label), .report(let label, _):
            label
        case .unknown: ""
        }
    }

    public var need: String? {
        switch self {
        case .try(_, let need), .skip(_, let need), .letGo(_, let need), .read(_, let need, _), .ignore(_, let need, _): need
        default: nil
        }
    }

    public var of: String? {
        switch self {
        case .read(_, _, let of), .ignore(_, _, let of), .signin(_, let of), .refresh(_, let of), .resume(_, let of), .browser(_, let of), .report(_, let of): of
        default: nil
        }
    }

    public var pressed: HomeLink.Act.Do? {
        switch self {
        case .try: .try
        case .skip: .skip
        case .letGo: .letGo
        case .read: .read
        case .ignore: .ignore
        default: nil
        }
    }
}
