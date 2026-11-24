import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

enum MomentReading {
    static func key(day: String, focus: String, marks: [String]? = nil) -> HomeLink.PageKey {
        var query = ["day": day, "focus": focus]
        if let marks, let list = try? JSONEncoder().encode(marks) { query["marks"] = String(decoding: list, as: UTF8.self) }
        return HomeLink.PageKey(HomeLink.Pages.Moment.route, query)
    }

    static func thread(chat: String, day: String) -> HomeLink.PageKey {
        HomeLink.PageKey(HomeLink.Pages.Thread.route, ["chat": chat, "day": day])
    }

    static func ref(_ record: HomeLink.Pages.MomentRecord) -> HomeLink.DayFile.RecordRef {
        HomeLink.DayFile.RecordRef(source: record.source, kind: record.kind, key: record.key)
    }

    static func date(_ ms: Int) -> Date { Date(timeIntervalSince1970: TimeInterval(ms) / 1000) }

    static func clock(_ ms: Int) -> String { Words.clock(date(ms)) }

    static func length(_ ms: Int) -> String { Words.duration(TimeInterval(ms) / 1000) }

    static func made(_ made: HomeLink.Pages.Made) -> HomeLink.Made {
        HomeLink.Made(by: made.by, atMs: made.atMs.map(Int64.init), state: HomeLink.Made.State(rawValue: made.state.rawValue) ?? .off, line: made.line,
                      ask: made.ask.map { HomeLink.Made.Ask(family: $0.family, item: $0.item, prompt: $0.prompt) },
                      choose: made.choose.map { HomeLink.Connector.Member.Step(value: $0.value, words: $0.words, note: $0.note) })
    }

    static func span(_ start: Int?, _ end: Int?) -> String? {
        guard let start else { return nil }
        guard let end, clock(end) != clock(start) else { return clock(start) }
        return clock(start) + "–" + clock(end)
    }
}

struct MomentInspector: View {
    let day: String
    let focus: String
    @StateObject private var reading: PageReading<HomeLink.Pages.Moment>
    @State private var only: Int?
    @State private var attempt = 0
    @Environment(\.scenePhase) private var scenePhase

    init(day: String, focus: String, marks: [String]? = nil) {
        self.day = day
        self.focus = focus
        _reading = StateObject(wrappedValue: PageReading(MomentReading.key(day: day, focus: focus, marks: marks)))
    }

    var body: some View {
        Group {
            if let answer = reading.page, answer.state != .rendering {
                VStack(alignment: .leading, spacing: 0) {
                    PageNote(drawn: reading.drawn).padding(.horizontal, Cockpit.Gap.edge)
                    if answer.state == .found, let moment = answer.moment {
                        MomentFrame(day: day, moment: moment, only: $only) { await reading.read() }
                    } else {
                        Inspector.Line(text: "This moment is no longer on this day.").padding(Cockpit.Space.s5)
                    }
                }
            } else if let failure = reading.failure {
                ReadLack(failure, lacks: "This isn't on this iPhone yet.", words: Self.sentence(failure),
                         retry: failure == .missing ? nil : { attempt += 1 })
                    .padding(Cockpit.Gap.edge)
            } else {
                Inspector.ReadingFrame(head: nil) { Inspector.Lines() }
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .readsAgain(failed: { reading.failure }) { attempt += 1 }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { attempt += 1 }
        }
        .task(id: attempt) {
            await reading.read()
            guard reading.page?.state == .rendering else { return }
            try? await Task.sleep(for: DayModel.renderingAgain)
            guard !Task.isCancelled else { return }
            attempt += 1
        }
        .onChange(of: reading.page?.moment?.key, initial: true) { _, key in
            if key != nil { only = reading.page?.moment?.letter }
        }
    }

    private static func sentence(_ failure: LifeReader.Failure) -> String? {
        switch failure {
        case .unpaired: "Pair with Lifestream to see this."
        case .reach: nil
        case .busy(let words, _, _, _): words
        case .missing: "This moment is not in Lifestream."
        case .refused(let words), .failed(let words), .unknown(let words): Inspector.Family.sentence(words)
        }
    }
}

private struct MomentFrame: View {
    let day: String
    let moment: HomeLink.Pages.DayMoment
    @Binding var only: Int?
    let read: @MainActor () async -> Void
    @EnvironmentObject private var reads: InspectorReads
    @State private var opened: InspectorOut?

    private var letter: HomeLink.Pages.Letter? {
        guard let only, case .mail(_, let letters) = moment.view, letters.indices.contains(only) else { return nil }
        return letters[only]
    }

    var body: some View {
        let alone = letter
        InspectorFrame(alone.map { $0.subject.isEmpty ? "(no subject)" : $0.subject } ?? moment.title,
                       icon: Cockpit.Icon(rawValue: moment.icon) ?? .info,
                       when: when(alone),
                       where: moment.near ?? moment.place?.name,
                       source: moment.products.isEmpty ? nil : moment.products.joined(separator: ", "),
                       out: alone == nil ? moment.out.flatMap(Self.out) ?? opened : opened) {
            if alone != nil, case .mail(true, _) = moment.view {
                Button(moment.name) { only = nil }
                    .buttonStyle(.cockpit(.plain, size: .small))
                    .accessibilityIdentifier("inspector.mail.all")
            }
            MomentBody(day: day, moment: moment, only: $only, read: read)
            Inspector.Faces(named: people(alone))
        } foot: {
            MomentSourceFold(source: moment.source)
        }
        .task(id: outRecord(alone).map(MomentReading.ref)) {
            guard let ref = outRecord(alone).map(MomentReading.ref) else {
                opened = nil
                return
            }
            opened = (try? await reads.record(ref))?.open.flatMap(Inspector.out)
        }
    }

    private func when(_ alone: HomeLink.Pages.Letter?) -> String {
        if let untimed = moment.untimed { return untimed }
        if let alone { return alone.atMs.map(MomentReading.clock) ?? "" }
        return [MomentReading.span(moment.startMs, moment.endMs), moment.lengthMs.map(MomentReading.length)]
            .compactMap { $0 }.joined(separator: Words.dot)
    }

    private func people(_ alone: HomeLink.Pages.Letter?) -> [(person: String?, name: String)] {
        guard let alone else { return moment.people.map { ($0.person, $0.name) } }
        return alone.person.map { [(alone.personId, $0)] } ?? []
    }

    private func outRecord(_ alone: HomeLink.Pages.Letter?) -> HomeLink.Pages.MomentRecord? {
        if let alone { return alone.record }
        return moment.out == nil ? moment.record : nil
    }

    private static func out(_ open: HomeLink.Pages.MomentOpen) -> InspectorOut? {
        URL(string: open.href).map { InspectorOut(open.label, url: $0) }
    }
}

private struct MomentSourceFold: View {
    let source: HomeLink.Pages.MomentSource

    var body: some View {
        if let record = source.records.first {
            RecordSourceFold(ref: HomeLink.DayFile.RecordRef(source: record.source, kind: record.kind, key: record.key),
                             unit: source.units.first?.unit)
        } else if let unit = source.units.first {
            ExtractSourceFold(family: unit.family, unit: unit.unit)
        }
    }
}
