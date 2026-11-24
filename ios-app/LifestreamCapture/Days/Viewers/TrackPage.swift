import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct TrackPage: View {
    let track: String
    let artist: String?
    @ObservedObject private var home = HomeToday.shared
    @State private var read: Read = .reading
    @State private var more = false
    @State private var olderFailed: LifeReader.Failure?

    enum Read: Equatable {
        case reading
        case read(Heard)
        case failed(LifeReader.Failure)
    }

    struct Play: Equatable, Identifiable {
        let id: String
        let at: String
        let app: String?
        let times: Int
    }

    struct Heard: Equatable {
        var total: Int
        var bars: [(month: String, plays: Int)]
        var months: [String]
        var plays: [Play]
        var read: Int
        var first: Play?
        var album: String?

        static func == (one: Heard, two: Heard) -> Bool {
            one.total == two.total && one.bars.map(\.month) == two.bars.map(\.month) && one.bars.map(\.plays) == two.bars.map(\.plays)
                && one.months == two.months && one.plays == two.plays && one.read == two.read && one.first == two.first
                && one.album == two.album
        }
    }

    var body: some View {
        OnePage(track) {
            head
            switch read {
            case .reading:
                WaitLine()
            case .failed(let failure):
                InPlaceLine(PeopleWords.failure(failure) ?? "Couldn't read these plays.") { Task { await load() } }
            case .read(let heard):
                FigureRow([.init(Words.count(heard.total), heard.total == 1 ? "play" : "plays"),
                           .init(heard.first.map { day($0.at) } ?? "–", "first"),
                           .init(heard.plays.first.map { day($0.at) } ?? "–", "last")])
                    .padding(.horizontal, -Cockpit.Gap.edge)
                WeekFigure(Words.count(heard.total), words: heard.total == 1 ? "play" : "plays",
                           bars: heard.bars.map { WeekFigure.Bar(count: $0.plays, noun: $0.plays == 1 ? "play" : "plays",
                                                                 when: Words.monthYear(ofDay: $0.month + "-01")) },
                           labels: heard.bars.map { String(Words.shortMonth(ofDay: $0.month + "-01").prefix(1)) }, bare: true,
                           marked: .none)
                if !heard.plays.isEmpty {
                    VStack(alignment: .leading, spacing: Cockpit.Gap.group) {
                        SectionLabel("Plays")
                        Card(group: true, flat: true) {
                            ForEach(Array(heard.plays.enumerated()), id: \.element.id) { index, play in
                                ListRow(day(play.at, long: true), value: [SearchWords.clock(local: play.at), play.app].compactMap { $0 }
                                    .joined(separator: Words.dot), separator: index < heard.plays.count - 1)
                                    .onAppear {
                                        if index == heard.plays.count - 1 { Task { await older() } }
                                    }
                            }
                        }
                        if !more, let olderFailed {
                            InPlaceLine(PeopleWords.failure(olderFailed) ?? "Couldn't read more plays.") { Task { await older() } }
                        }
                    }
                }
            }
        }
        .accessibilityIdentifier("listening.track")
        .task(id: track + (artist ?? "")) { await load() }
    }

    private var head: some View {
        HStack(spacing: Cockpit.Space.s4) {
            IconTile(.listening, side: Cockpit.Size.avatarTile, ink: Cockpit.Color.textSecondary)
            VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
                Text(track)
                    .cockpit(.title1)
                    .foregroundStyle(Cockpit.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                let album = if case .read(let heard) = read { heard.album } else { String?.none }
                let by = [artist, album].compactMap { $0 }.joined(separator: Words.dot)
                if !by.isEmpty {
                    Text(by).cockpit(.subhead).foregroundStyle(Cockpit.Color.textSecondary)
                }
            }
        }
    }

    private func day(_ at: String, long: Bool = false) -> String {
        let day = String(at.prefix(10))
        return long ? Words.dateTitle(day, today: home.today) : Words.shortDay(day, weekday: false, today: home.today)
    }

    private var match: [HomeLink.CountTableQuery.Match] { Self.match(track: track, artist: artist) }

    static func match(track: String, artist: String?) -> [HomeLink.CountTableQuery.Match] {
        [.init("track", whole: track)] + (artist.map { [.init("artist", whole: $0)] } ?? [])
    }

    static func monthsAsked(track: String, artist: String?, cursor: String?) -> HomeLink.CountTableQuery {
        HomeLink.CountTableQuery(of: "plays", match: match(track: track, artist: artist), measure: "times", op: "sum",
                                 by: artist == nil ? ["month", "artist"] : ["month"], cursor: cursor)
    }

    private func load() async {
        read = .reading
        do {
            let life = AppRuntime.shared.life
            let byMonth = try await Self.whole { cursor in
                try await life.countTable(Self.monthsAsked(track: track, artist: artist, cursor: cursor))
            }
            let counted = Self.months(byMonth, track: track, artist: artist)
            let months = counted.filter { $0.value > 0 }.keys.sorted(by: >)
            let now = String(home.today.prefix(7)) + "-01"
            let bars = (0..<12).reversed().map { back in
                let month = String(Words.shiftMonth(now, -back).prefix(7))
                return (month: month, plays: counted[month] ?? 0)
            }
            var heard = Heard(total: counted.values.reduce(0, +), bars: bars, months: months, plays: [], read: 0)
            if let newest = months.first {
                let (plays, album) = try await self.plays(in: newest)
                heard.plays = plays
                heard.album = album
                heard.read = 1
                if months.count == 1 {
                    heard.first = plays.last
                } else {
                    heard.first = try await self.plays(in: months[months.count - 1]).plays.last
                }
            }
            read = .read(heard)
        } catch is CancellationError {
            return
        } catch {
            read = .failed((error as? LifeReader.Failure) ?? .refused(String(describing: error)))
        }
    }

    private func older() async {
        guard case .read(var heard) = read, heard.read < heard.months.count, !more else { return }
        more = true
        defer { more = false }
        let found: (plays: [Play], album: String?)
        do {
            found = try await plays(in: heard.months[heard.read])
        } catch {
            if !(error is CancellationError) { olderFailed = (error as? LifeReader.Failure) ?? .refused(String(describing: error)) }
            return
        }
        olderFailed = nil
        heard.plays += found.plays
        heard.album = heard.album ?? found.album
        heard.read += 1
        read = .read(heard)
    }

    private func plays(in month: String) async throws -> (plays: [Play], album: String?) {
        let read = { (cursor: String?) in
            try await AppRuntime.shared.life.countTable(HomeLink.CountTableQuery(
                of: "plays", match: match, measure: "times", op: "sum", by: ["item"], order: "time", from: month + "-01",
                to: SearchWords.monthEnd(month), cursor: cursor))
        }
        return Self.plays(try await Self.whole(read), track: track, artist: artist)
    }

    static func isTrack(_ table: HomeLink.CountTable, _ row: [HomeLink.JSON], track: String, artist: String?) -> Bool {
        let by = table.value("artist", in: row)?.string
        return (!table.columns.contains("track") || table.value("track", in: row)?.string == track)
            && (!table.columns.contains("artist") || (by?.isEmpty == false ? by : nil) == artist)
    }

    static func months(_ tables: [HomeLink.CountTable], track: String, artist: String?) -> [String: Int] {
        tables.reduce(into: [:]) { counted, table in
            for row in table.rows where isTrack(table, row, track: track, artist: artist) {
                guard let month = table.value("month", in: row)?.string, let sum = table.value("sum", in: row)?.number else { continue }
                counted[month, default: 0] += Int(sum)
            }
        }
    }

    static func whole(_ read: (String?) async throws -> HomeLink.CountTable) async throws -> [HomeLink.CountTable] {
        var tables = [try await read(nil)]
        while let next = tables[tables.count - 1].next {
            tables.append(try await read(next))
        }
        return tables
    }

    static func plays(_ tables: [HomeLink.CountTable], track: String, artist: String?) -> (plays: [Play], album: String?) {
        let plays = tables.flatMap { table in
            table.rows.compactMap { row -> Play? in
                guard isTrack(table, row, track: track, artist: artist), let at = table.value("time", in: row)?.string else { return nil }
                return Play(id: table.value("ref", in: row)?.string ?? at, at: at, app: table.value("app", in: row)?.string,
                            times: Int(table.value("times", in: row)?.number ?? 1))
            }
        }
        let album = tables.lazy.flatMap { table in
            table.rows.lazy.filter { isTrack(table, $0, track: track, artist: artist) }.compactMap { table.value("album", in: $0)?.string }
        }.first
        return (plays.reversed(), album)
    }
}
