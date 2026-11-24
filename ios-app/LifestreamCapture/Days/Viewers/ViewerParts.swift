import Cockpit
import Foundation
import HomeLink
import LifestreamCaptureCore
import SwiftUI

extension Inspector {
    enum Family {
        static let owner = "the user"

        static func firstLine(_ text: String) -> String {
            String(text.prefix { $0 != "\n" })
        }

        static func splitAtColon(_ words: String) -> (String, String) {
            guard let colon = words.range(of: ": ") else { return (words, "") }
            return (String(words[..<colon.lowerBound]), String(words[colon.upperBound...]))
        }

        static func sentence(_ words: String) -> String {
            words.prefix(1).uppercased() + words.dropFirst()
        }
    }
}

extension Inspector {
    struct Section<Content: View>: View {
        let title: String?
        let content: Content

        init(_ title: String? = nil, @ViewBuilder content: () -> Content) {
            self.title = title
            self.content = content()
        }

        var body: some View {
            VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                if let title { SectionLabel(title) }
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

extension Inspector {
    struct Facts: View {
        let facts: [(label: String, value: String)]
        var links: [String: URL] = [:]

        var body: some View {
            Card(group: true) {
                KeyValueRows {
                    ForEach(Array(facts.enumerated()), id: \.offset) { index, fact in
                        let last = index == facts.count - 1
                        if let url = links[fact.label] {
                            Link(destination: url) { KeyValueRow(fact.label, fact.value, separator: !last, outward: true, linked: true) }
                        } else {
                            KeyValueRow(fact.label, fact.value, separator: !last)
                        }
                    }
                }
            }
        }
    }
}

extension Inspector {
    struct Faces: View {
        var people: [HomeLink.Person] = []
        var strangers: [String] = []
        var named: [(person: String?, name: String)] = []
        var spaced = false
        @Environment(\.inspectorGo) private var go

        var body: some View {
            let faces = people.map { person in
                FaceRow.Face(id: person.id, name: person.name, photo: HomePictures.shared.face(person.photo?.hash),
                             loading: person.photo != nil) { go(.person(person.id)) }
            } + strangers.map { FaceRow.Face(id: $0, name: $0) }
                + named.map { each in FaceRow.Face(id: each.person ?? each.name, name: each.name, open: each.person.map { id in { go(.person(id)) } }) }
            if !faces.isEmpty {
                FaceRow(faces)
                    .padding(.top, spaced ? 0 : Cockpit.Gap.edge - Cockpit.Gap.group)
                    .background { ForEach(people) { Color.clear.readsFace($0.photo?.hash, size: .row) } }
            }
        }
    }

    struct Meters: View {
        let items: [(label: String, value: String, amount: Double)]

        var body: some View {
            let largest = items.map(\.amount).max() ?? 0
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    if items.count == 1 {
                        HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s3) {
                            Text(item.label).cockpit(.body).foregroundStyle(Cockpit.Color.text).lineLimit(1)
                            Spacer(minLength: 0)
                            Text(item.value).cockpit(.subhead).monospacedDigit().foregroundStyle(Cockpit.Color.textSecondary).fixedSize()
                        }
                        .accessibilityElement(children: .combine)
                    } else {
                        Meter(item.label, value: item.value, share: largest > 0 ? item.amount / largest : 0)
                    }
                }
            }
        }
    }
}

extension Inspector {
    struct Voice: View {
        let words: String

        var body: some View {
            Text("“\(words.trimmingCharacters(in: .whitespacesAndNewlines))”")
                .cockpit(.voice)
                .foregroundStyle(Cockpit.Color.text)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
    }
}

extension Inspector {
    struct Line: View {
        let text: String

        var body: some View {
            Text(text)
                .cockpit(.body)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
    }
}

extension Inspector {
    struct TodoMark: View {
        let done: Bool

        var body: some View {
            ZStack {
                Circle().strokeBorder(Cockpit.Color.textSecondary, lineWidth: 1.5)
                if done { Icon(.done, size: .xs).foregroundStyle(Cockpit.Color.textSecondary) }
            }
            .frame(width: 20, height: 20)
        }
    }

    struct Folded<Content: View>: View {
        let title: String
        let content: Content
        @State private var open = false
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        init(_ title: String, @ViewBuilder content: () -> Content) {
            self.title = title
            self.content = content()
        }

        var body: some View {
            VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                Button {
                    withAnimation(reduceMotion ? .easeInOut(duration: Cockpit.Duration.fast) : Cockpit.Ease.spring()) { open.toggle() }
                } label: {
                    HStack(spacing: Cockpit.Space.s2) {
                        Text(title).cockpit(.body)
                        Spacer(minLength: 0)
                        Icon(open ? .collapse : .expand, size: .xs).padding(.trailing, -1.7)
                    }
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .frame(minHeight: 52)
                    .overlay(alignment: .top) {
                        Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.pixelRule).accessibilityHidden(true)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(open ? "Open" : "Folded")
                if open { content }
            }
            .padding(.bottom, open ? 0 : -Cockpit.Gap.head)
        }
    }
}

extension Inspector {
    struct Writing: View {
        let words: String

        private enum Block {
            case paragraph(String)
            case item(String, number: String?)
            case todo(String, done: Bool)
        }

        private var blocks: [Block] {
            words.trimmingCharacters(in: .whitespacesAndNewlines).components(separatedBy: "\n").compactMap { line in
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if let box = trimmed.range(of: #"^([-*] )?\[[ xX]\] ?"#, options: .regularExpression) {
                    let done = trimmed[box].contains { $0 == "x" || $0 == "X" }
                    return .todo(String(trimmed[box.upperBound...]), done: done)
                }
                if let bullet = trimmed.range(of: #"^[-*•] "#, options: .regularExpression) {
                    return .item(String(trimmed[bullet.upperBound...]), number: nil)
                }
                if let number = trimmed.range(of: #"^\d+[.)] "#, options: .regularExpression) {
                    return .item(String(trimmed[number.upperBound...]), number: String(trimmed[number].dropLast(2)) + ".")
                }
                return trimmed.isEmpty ? .paragraph("") : .paragraph(line)
            }
        }

        var body: some View {
            VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                    switch block {
                    case .paragraph(let line):
                        if line.isEmpty { Spacer().frame(height: Cockpit.Space.s2) } else { text(line, done: false) }
                    case .item(let line, let number):
                        HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
                            Text(number ?? "•").cockpit(.body).foregroundStyle(Cockpit.Color.textTertiary).monospacedDigit()
                            text(line, done: false)
                        }
                    case .todo(let line, let done):
                        HStack(alignment: .center, spacing: Cockpit.Space.s3) {
                            Inspector.TodoMark(done: done).frame(width: 36, height: Cockpit.Space.s6).foregroundStyle(done ? Cockpit.Color.textTertiary : Cockpit.Color.textSecondary)
                                .accessibilityLabel(done ? "Done" : "Not done")
                            text(line, done: done)
                        }
                        .frame(minHeight: Cockpit.Space.s12)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            .padding(.top, { if case .todo? = blocks.first { -Cockpit.Space.s2 } else { 0 } }())
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
        }

        private func text(_ line: String, done: Bool) -> some View {
            Text(Self.linked(line))
                .cockpit(.body)
                .foregroundStyle(done ? Cockpit.Color.textTertiary : Cockpit.Color.text)
                .strikethrough(done, color: Cockpit.Color.textTertiary)
                .tint(Cockpit.Color.text)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        static func linked(_ line: String) -> AttributedString {
            var text = AttributedString(line)
            guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return text }
            for match in detector.matches(in: line, range: NSRange(line.startIndex..., in: line)) {
                guard let url = match.url, url.scheme == "http" || url.scheme == "https",
                      let range = Range(match.range, in: line), let found = Range(range, in: text) else { continue }
                text[found].link = url
                text[found].underlineStyle = .single
            }
            return text
        }
    }
}


extension Inspector {
    enum MadeVerb {
        case describe, transcribe

        var now: String { self == .describe ? "Describe now" : "Transcribe now" }
        var again: String { self == .describe ? "Describe again" : "Transcribe again" }
    }

    @MainActor final class MadeActs: ObservableObject {
        struct Unlanded: Equatable {
            let said: HomeLink.ActSaid
            let route: String
        }

        @Published private(set) var sending: Set<String> = []
        @Published private(set) var failed: [String: Unlanded] = [:]
        private let life: LifeReader

        init(life: LifeReader = AppRuntime.shared.life) {
            self.life = life
        }

        static func key(_ ask: HomeLink.Made.Ask) -> String { ask.family + "\0" + ask.item + "\0" + ask.prompt }

        func choose(_ ask: HomeLink.Made.Ask, route: String, read: @escaping @MainActor () async -> Void) async {
            let key = Self.key(ask)
            guard !sending.contains(key) else { return }
            sending.insert(key)
            failed[key] = nil
            do {
                try await life.process(ask, route: route)
            } catch {
                failed[key] = Unlanded(said: Self.said(error), route: route)
            }
            await read()
            sending.remove(key)
        }

        func awaits(_ made: HomeLink.Made?) -> Bool {
            guard let made, made.ask != nil else { return false }
            return made.state == .waiting && made.choose.isEmpty
        }

        private static func said(_ error: Error) -> HomeLink.ActSaid {
            if case .missing? = error as? LifeReader.Failure { return .refused("Lifestream does not hold this.") }
            return HomeLink.ActSaid(error)
        }
    }

    struct MadeAct: View {
        let made: HomeLink.Made
        let ask: HomeLink.Made.Ask
        let first: HomeLink.Connector.Member.Step
        let verb: MadeVerb
        @ObservedObject var acts: MadeActs
        let read: @MainActor () async -> Void

        init?(made: HomeLink.Made, verb: MadeVerb, acts: MadeActs, read: @escaping @MainActor () async -> Void) {
            guard let ask = made.ask, let first = made.choose.first else { return nil }
            self.made = made
            self.ask = ask
            self.first = first
            self.verb = verb
            self.acts = acts
            self.read = read
        }

        static func to(_ step: HomeLink.Connector.Member.Step) -> String {
            [step.words, step.note].compactMap { $0 }.joined(separator: Words.dot)
        }

        var body: some View {
            let busy = acts.sending.contains(MadeActs.key(ask))
            let control = Group {
                if made.state == .done {
                    Menu {
                        ForEach(made.choose, id: \.value) { step in
                            Button {
                                Task { await acts.choose(ask, route: step.value, read: read) }
                            } label: {
                                Text(step.words)
                                if let note = step.note { Text(note) }
                            }
                        }
                    } label: {
                        Text(verb.again)
                    }
                    .menuStyle(.button)
                    .menuOrder(.fixed)
                    .accessibilityIdentifier("viewer.made.again")
                } else {
                    Button(verb.now) { Task { await acts.choose(ask, route: first.value, read: read) } }
                        .accessibilityIdentifier("viewer.made.now")
                }
            }
            .buttonStyle(.cockpit(.secondary, size: .small, busy: busy))
            .disabled(busy)
            .fixedSize()
            if made.state == .done {
                control
            } else {
                VStack(alignment: .trailing, spacing: Cockpit.Space.s1) {
                    control
                    Text(Self.to(first))
                        .cockpit(.footnote)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("viewer.made.to")
                }
            }
        }
    }

    struct Made: View {
        let made: HomeLink.Made
        let verb: MadeVerb
        @ObservedObject var acts: MadeActs
        var mine = false
        let read: @MainActor () async -> Void

        var body: some View {
            let line = made.line
            let failed = made.ask.flatMap { acts.failed[MadeActs.key($0)] }
            let act = MadeAct(made: made, verb: verb, acts: acts, read: read)
            if line != nil || act != nil || failed != nil {
                VStack(alignment: mine ? .trailing : .leading, spacing: Cockpit.Space.s2) {
                    HStack(alignment: .center, spacing: Cockpit.Space.s3) {
                        if let line {
                            Text(line)
                                .cockpit(.footnote)
                                .foregroundStyle(Cockpit.Color.textTertiary)
                                .multilineTextAlignment(mine ? .trailing : .leading)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
                                .accessibilityIdentifier("viewer.made.line")
                        } else {
                            Spacer(minLength: 0)
                        }
                        if let act { act }
                    }
                    if let failed, let ask = made.ask {
                        InPlaceLine(InPlaceLine.Said(failed.said), retry: failed.said.sendsAgain ? {
                            Task { await acts.choose(ask, route: failed.route, read: read) }
                        } : nil)
                        .accessibilityIdentifier("viewer.made.failure")
                    }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("viewer.made")
            }
        }
    }
}

extension Inspector {
    struct Went: View {
        let went: InspectorReads.Went
        @State private var seeing: InspectorReads.Went?
        @EnvironmentObject private var reads: InspectorReads

        var body: some View {
            HStack(alignment: .center, spacing: Cockpit.Space.s3) {
                Text(SentWords.fact(went.row, kinds: went.kinds))
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("viewer.sent.line")
                if went.row.what == "ask" {
                    Button(SentSheet.see) { seeing = went }
                        .buttonStyle(.cockpit(.secondary, size: .small))
                        .fixedSize()
                        .accessibilityIdentifier("viewer.sent.see")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("viewer.sent")
            .sheet(item: $seeing) { went in
                SentSheet(seq: went.row.seq).environmentObject(reads)
            }
        }
    }

    struct SentSheet: View {
        let seq: Int
        @EnvironmentObject private var reads: InspectorReads
        @State private var read: InspectorReads.Went?
        @State private var failure: LifeReader.Failure?
        @State private var attempt = 0

        static let see = "See what was sent"
        static let title = "What was sent"
        static let erased = "What was sent is no longer kept: an erasure took its request."

        var body: some View {
            NavigationStack {
                SheetFrame(Self.title, icon: .send) {
                    if let read { parts(read) }
                    if let failure {
                        ReadLack(failure, lacks: "What was sent isn't on this iPhone yet.", words: Self.words(failure)) { attempt += 1 }
                    }
                }
                .reading(read == nil && failure == nil)
                .toolbar(.hidden, for: .navigationBar)
            }
            .drawerRest()
            .accessibilityIdentifier("viewer.sent.sheet")
            .readsAgain(failed: { failure }) { attempt += 1 }
            .task(id: [seq, attempt]) {
                failure = nil
                do {
                    read = try await reads.sent(seq: seq)
                } catch is CancellationError {
                } catch {
                    failure = error as? LifeReader.Failure ?? .refused(String(describing: error))
                }
            }
        }

        @ViewBuilder private func parts(_ read: InspectorReads.Went) -> some View {
            let row = read.row
            let when = Words.date(ms: row.atMs)
            SheetPart(nil) {
                SettingRow("To", value: row.receiver)
                SettingRow("When", value: Words.stamp(when, weekday: false))
                let hider = SentWords.hider(row)
                SettingRow("Hidden", line: SentWords.hid(row, kinds: read.kinds), separator: hider != nil || row.pictures > 0) { EmptyView() }
                if let hider {
                    SettingRow("Hidden by", value: hider, separator: row.pictures > 0)
                }
                if row.pictures > 0 {
                    SettingRow("Pictures", line: Words.count(row.pictures, "picture") + " went with it, made as the level says.",
                               separator: false) { EmptyView() }
                }
            }
            SheetPart(Self.title) {
                Text(row.sent.map { Self.readable($0.body) } ?? Self.erased)
                    .cockpit(row.sent == nil ? .footnote : .monoData)
                    .foregroundStyle(row.sent == nil ? Cockpit.Color.textSecondary : Cockpit.Color.text)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(Cockpit.Space.s4)
                    .accessibilityIdentifier("viewer.sent.body")
            }
        }

        static func readable(_ body: String) -> String {
            guard let value = try? JSONSerialization.jsonObject(with: Data(body.utf8), options: .fragmentsAllowed),
                  let laid = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .withoutEscapingSlashes, .fragmentsAllowed])
            else { return body }
            return String(decoding: laid, as: UTF8.self)
        }

        private static func words(_ failure: LifeReader.Failure) -> String? {
            switch failure {
            case .missing: "This is no longer in what left Lifestream."
            case .reach: nil
            case .unpaired: "Pair with Lifestream to see this."
            case .busy(let words, _, _, _): words
            case .refused(let words), .failed(let words), .unknown(let words): Family.sentence(words)
            }
        }
    }
}

extension View {
    func readsAgain(while awaiting: Bool, _ read: @escaping @MainActor () async -> Void) -> some View {
        task(id: awaiting) {
            while awaiting {
                try? await Task.sleep(for: LifeReader.rereadEvery)
                guard !Task.isCancelled else { return }
                await read()
            }
        }
    }
}
