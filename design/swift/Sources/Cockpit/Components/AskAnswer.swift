import SwiftUI

public struct AskRef: Sendable, Hashable {
    let title: String
    let day: String?
    let image: Bool
    let source: String?
    let voice: Voice?

    public struct Voice: Sendable, Hashable {
        let record: String
        let seconds: Int?
        let from: String?
        let mine: Bool
        let when: String?

        public init(record: String, seconds: Int?, from: String?, mine: Bool, when: String?) {
            self.record = record
            self.seconds = seconds
            self.from = from
            self.mine = mine
            self.when = when
        }

        var caption: String { [mine ? "You" : from ?? VoiceWords.someone, when].compactMap { $0 }.joined(separator: " · ") }
    }

    public init(_ title: String, day: String?, image: Bool = false, source: String? = nil, voice: Voice? = nil) {
        self.title = title
        self.day = day
        self.image = image
        self.source = source
        self.voice = voice
    }

    var said: String { [title, day].compactMap { $0 }.joined(separator: " · ") }
    var stands: String? { voice == nil ? source : nil }
}

public enum AskEnd {
    case running, done, stopped
    case failed(String, retry: () -> Void)
}

public enum AskFit: Sendable { case own, fill }

public struct AskFeedback {
    let label: String
    let send: () -> Void

    public init(_ label: String, send: @escaping () -> Void) {
        self.label = label
        self.send = send
    }
}

public struct AskAnswer<Picture: View, Voice: View>: View {
    let trace: AskTrace
    let refs: [String: AskRef]?
    let open: String?
    let end: AskEnd
    let cite: (String) -> Void
    let picture: (String, AskRef, AskFit) -> Picture
    let voice: (String, AskRef.Voice) -> Voice
    let seen: AskSeen?
    let modelView: Binding<Bool>?
    let feedback: AskFeedback?
    var forcedHover = false
    @State private var hovering = false
    @State private var copied = false
    @State private var clock: SeenClock?
    @Environment(\.cockpitPlatform) private var platform
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(_ trace: AskTrace, refs: [String: AskRef]?, open: String? = nil, end: AskEnd = .done,
                seen: AskSeen? = nil, modelView: Binding<Bool>? = nil, feedback: AskFeedback? = nil,
                cite: @escaping (String) -> Void, @ViewBuilder picture: @escaping (String, AskRef, AskFit) -> Picture,
                @ViewBuilder voice: @escaping (String, AskRef.Voice) -> Voice) {
        self.trace = trace
        self.refs = refs
        self.open = open
        self.end = end
        self.seen = seen
        self.modelView = modelView
        self.feedback = feedback
        self.cite = cite
        self.picture = picture
        self.voice = voice
    }

    public var body: some View {
        let whole = settled
        TimelineView(AskFrames(until: until(whole))) { context in
            let now = context.date.timeIntervalSinceReferenceDate
            drawn(trace.frame(at: now), whole: whole, at: now)
        }
        .modifier(SeenFlip(on: on, clock: $clock))
    }

    private var on: Bool { modelView?.wrappedValue == true }

    private var candidate: AskSeen? { modelView != nil && Self.finished(end) ? seen : nil }

    private var settled: Drawn? {
        guard let candidate else { return nil }
        return Drawn(trace.text, refs: refs, cut: !Self.done(end), seen: candidate.answered)
    }

    private func until(_ whole: Drawn?) -> TimeInterval? {
        guard let settles = trace.settles else { return nil }
        guard let clock, let seen = seeing(whole) else { return settles }
        return max(settles, clock.settles(seen.asked.count + (whole?.order.count ?? 0)))
    }

    private func seeing(_ drawn: Drawn?) -> AskSeen? {
        drawn?.seeing == true ? candidate : nil
    }

    private func drawn(_ frame: AskTrace.Frame, whole: Drawn?, at now: TimeInterval) -> some View {
        let end = frame.settled ? self.end : .running
        let finished = Self.finished(end)
        let drawn = (frame.settled ? whole : nil) ?? Drawn(frame.markdown, refs: refs, cut: !Self.done(end))
        let seen = frame.settled ? seeing(drawn) : nil
        let shown = seen.map { seen in
            Shown(showing: SeenShowing(now: now, on: on, clock: clock, size: platform.style(.reading).size), after: seen.asked.count, drawn: drawn)
        }
        let fresh = reduceMotion ? [] : frame.fresh
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(drawn.items.indices, id: \.self) { index in
                item(drawn.items[index], after: index == 0 ? nil : drawn.items[index - 1], fresh: index == drawn.items.count - 1 ? fresh : [],
                     shown: shown)
            }
            switch end {
            case .stopped:
                Text("Stopped")
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .padding(.top, drawn.items.isEmpty ? 0 : Cockpit.Space.s3)
            case let .failed(sentence, retry):
                InPlaceLine(sentence, retry: retry)
                    .padding(.top, drawn.items.isEmpty ? 0 : Cockpit.Space.s3)
            case .running, .done:
                EmptyView()
            }
            if frame.answering || Self.ended(end) {
                copyRow(end, eye: seen != nil)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .contextMenu { if platform == .ios && finished { Button("Copy", action: copy) } }
        .accessibilityAction(named: "Copy") { if finished { copy() } }
        .foregroundStyle(Cockpit.Color.text)
        .tint(Cockpit.Color.text)
        .textSelection(.enabled)
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == Drawn.scheme else { return .systemAction }
            if refs != nil, let first = Drawn.handles(of: url.absoluteString).first { cite(first) }
            return .handled
        })
    }

    @ViewBuilder private func copyRow(_ end: AskEnd, eye: Bool) -> some View {
        let finished = Self.finished(end)
        let ended = Self.ended(end)
        let failed = ended && !finished
        Group {
            if platform == .mac {
                HStack(spacing: Cockpit.Space.s1) {
                    if !failed {
                        Button("Copy", action: copy)
                            .buttonStyle(.cockpit(.plain, size: .small))
                            .opacity(finished && (hovering || forcedHover) ? 1 : 0)
                    }
                    if finished, eye, let modelView {
                        SeenEye(on: modelView.wrappedValue) { modelView.wrappedValue.toggle() }
                            .opacity(modelView.wrappedValue || hovering || forcedHover ? 1 : 0)
                    }
                    if let feedback {
                        more(feedback)
                            .opacity(ended && (hovering || forcedHover) ? 1 : 0)
                    }
                }
                .padding(.top, Cockpit.Space.s1)
            } else {
                HStack(spacing: Cockpit.Space.s1) {
                    if !failed {
                        Button(action: copy) {
                            Icon(copied ? .done : .copy, size: .md)
                                .foregroundStyle(Cockpit.Color.textTertiary)
                                .frame(width: Cockpit.Size.composerControl, height: Cockpit.Size.composerControl)
                                .padding(4)
                                .contentShape(Rectangle())
                                .padding(-4)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Copy")
                        .accessibilityIdentifier("ask.copy")
                    }
                    if finished, eye, let modelView {
                        SeenEye(on: modelView.wrappedValue) { modelView.wrappedValue.toggle() }
                    }
                    if let feedback { more(feedback) }
                }
                .padding(.top, Cockpit.Space.s3 - 2)
                .padding(.leading, -Cockpit.Space.s2)
                .opacity(ended ? 1 : 0)
            }
        }
        .allowsHitTesting(ended)
        .accessibilityHidden(!ended)
        .animation(Cockpit.Ease.out(Cockpit.Duration.open), value: ended)
    }

    private func more(_ feedback: AskFeedback) -> some View {
        let side = platform == .ios ? Cockpit.Size.composerControl : 28
        return Menu {
            Button(action: feedback.send) { Label { Text(feedback.label) } icon: { MenuIcon.image(.message) } }
                .accessibilityIdentifier("ask.feedback")
        } label: {
            Icon(.more, size: platform == .ios ? .md : .sm)
                .foregroundStyle(Cockpit.Color.textTertiary)
                .frame(width: side, height: side)
                .padding(4)
                .contentShape(Rectangle())
                .padding(-4)
        }
        .menuIndicator(.hidden)
        .menuOrder(.fixed)
        .buttonStyle(.plain)
        .accessibilityLabel("More")
        .help("More")
        .accessibilityIdentifier("ask.more")
    }

    private static func done(_ end: AskEnd) -> Bool {
        if case .done = end { true } else { false }
    }

    private static func finished(_ end: AskEnd) -> Bool {
        switch end {
        case .done, .stopped: true
        case .running, .failed: false
        }
    }

    private static func ended(_ end: AskEnd) -> Bool {
        if case .running = end { false } else { true }
    }

    private func copy() {
        Pasteboard.copy(Drawn.copied(trace.text))
        copied = true
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            copied = false
        }
    }


    @ViewBuilder private func item(_ item: Drawn.Item, after previous: Drawn.Item?, fresh: [AskTrace.Fresh], shown: Shown?) -> some View {
        switch item {
        case let .block(block):
            self.block(block, fresh: fresh, shown: shown)
                .padding(.top, previous == nil ? 0 : gap(block, after: previous))
        case let .pictures(handles):
            folding(Pictures(handles: handles.compactMap { handle in refs?[handle].map { (handle, $0) } }, cite: cite, picture: picture), shown: shown)
        case let .voices(handles):
            folding(VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                ForEach(handles, id: \.self) { handle in
                    if let note = refs?[handle]?.voice { voice(handle, note) }
                }
            }, shown: shown)
        }
    }

    private func folding(_ media: some View, shown: Shown?) -> some View {
        let folded = shown != nil && on
        return media
            .padding(.top, Cockpit.Space.s3)
            .frame(height: folded ? 0 : nil, alignment: .top)
            .clipped()
            .opacity(folded ? 0 : 1)
            .allowsHitTesting(!folded)
            .accessibilityHidden(folded)
            .animation(reduceMotion ? .easeInOut(duration: Cockpit.Duration.fast) : Cockpit.Ease.out(Cockpit.Duration.base), value: folded)
            .transition(.opacity.animation(.easeOut(duration: Cockpit.Duration.fast)))
    }

    private func gap(_ block: Drawn.Block, after previous: Drawn.Item?) -> CGFloat {
        if case .heading = block.kind { return Cockpit.Space.s5 }
        if case let .block(before) = previous, block.list != nil, before.list != nil, block.list?.root == before.list?.root {
            return Cockpit.Space.s1
        }
        return Cockpit.Space.s3
    }

    @ViewBuilder private func block(_ block: Drawn.Block, fresh: [AskTrace.Fresh], shown: Shown?) -> some View {
        switch block.kind {
        case let .text(runs):
            let words = text(runs, fresh: fresh, shown: shown).cockpit(.reading)
            if let list = block.list {
                HStack(alignment: .firstTextBaseline, spacing: Cockpit.Space.s2) {
                    Text(list.marker)
                        .cockpit(.reading)
                        .monospacedDigit()
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .opacity(list.first ? 1 : 0)
                        .frame(minWidth: Cockpit.Space.s3, alignment: .trailing)
                    words
                }
                .padding(.leading, CGFloat(list.depth - 1) * Cockpit.Space.s5)
                .foregroundStyle(block.quote ? Cockpit.Color.textSecondary : Cockpit.Color.text)
            } else if block.quote {
                words
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .padding(.leading, Cockpit.Space.s3)
                    .overlay(alignment: .leading) { Rectangle().fill(Cockpit.Color.border).frame(width: Cockpit.Stroke.border) }
            } else {
                words
            }
        case let .heading(runs):
            text(runs, fresh: fresh, shown: shown).cockpit(.reading).fontWeight(.semibold)
        case let .code(code):
            Text(verbatim: shown.map { $0.code(code, on: on) } ?? String(code.characters))
                .contentTransition(.opacity)
                .animation(.easeInOut(duration: Cockpit.Duration.fast), value: on)
                .font(.system(size: platform.style(.reading).size * 0.87, design: .monospaced))
                .lineSpacing(4)
                .padding(.vertical, Cockpit.Space.s2)
                .padding(.horizontal, Cockpit.Space.s3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: Cockpit.Radius.sm, style: .continuous).fill(Cockpit.Color.well))
        case .rule:
            Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.Stroke.border)
        case let .table(rows):
            table(rows, shown: shown)
        }
    }

    private func table(_ rows: [Drawn.Row], shown: Shown?) -> some View {
        ViewThatFits(in: .horizontal) {
            grid(rows, shown: shown).fixedSize(horizontal: true, vertical: false)
            ScrollView(.horizontal) { grid(rows, shown: shown) }
        }
    }

    private func grid(_ rows: [Drawn.Row], shown: Shown?) -> some View {
        Grid(alignment: .leading, horizontalSpacing: Cockpit.Space.s4, verticalSpacing: 0) {
            ForEach(rows.indices, id: \.self) { index in
                GridRow {
                    ForEach(rows[index].cells.indices, id: \.self) { column in
                        text(rows[index].cells[column], shown: shown)
                            .cockpit(.reading)
                            .monospacedDigit()
                            .fontWeight(rows[index].header ? .medium : nil)
                            .foregroundStyle(rows[index].header ? Cockpit.Color.textSecondary : Cockpit.Color.text)
                            .padding(.vertical, Cockpit.Space.s1)
                    }
                }
                Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.Stroke.border)
            }
        }
    }


    private static var citePad: CGFloat { 6 }
    private func citeApart(after previous: Drawn.Piece?) -> CGFloat {
        if case .cite? = previous { return 1 }
        return platform == .ios ? 3 : 1
    }

    private func styled(_ words: AttributedString, _ intent: InlinePresentationIntent, link: Bool) -> Text {
        var piece = Text(words)
        if intent.contains(.stronglyEmphasized) { piece = piece.fontWeight(.semibold) }
        if intent.contains(.emphasized) { piece = piece.italic() }
        if intent.contains(.strikethrough) { piece = piece.strikethrough() }
        if intent.contains(.code) { piece = piece.font(.system(size: platform.style(.reading).size * 0.87, design: .monospaced)) }
        if link { piece = piece.underline(true, color: Cockpit.Color.data3) }
        return piece
    }

    private func text(_ runs: [Drawn.Run], fresh: [AskTrace.Fresh] = [], shown: Shown? = nil) -> some View {
        let cited = platform.style(.footnote)
        var whole = Text("")
        var previous: Drawn.Piece?
        for piece in Drawn.pieces(runs, shown: shown, closeUp: platform == .ios) {
            switch piece {
            case let .words(words, intent, link):
                whole = Text("\(whole)\(styled(words, intent, link: link))")
            case let .detail(detail, look):
                if let shown { whole = Text("\(whole)\(shown.text(detail, look: look))") }
            case let .cite(handles, number):
                let font = Font.system(size: cited.size, weight: .medium).monospacedDigit()
                if #available(macOS 15, *) {
                    let apart = citeApart(after: previous)
                    let before = Text("\u{202F}").kerning(Self.citePad + apart - 0.115 * cited.size)
                    let last = Text(String(number.suffix(1))).kerning(Self.citePad)
                    let piece = Text("\(before)\(String(number.dropLast()))\(last)")
                        .font(font)
                        .foregroundColor(Cockpit.Color.textSecondary)
                        .customAttribute(CiteMark(handles: handles, number: number, open: open.map { handles.contains($0) } ?? false, apart: apart))
                    whole = Text("\(whole)\(piece)")
                } else {
                    if case .cite? = previous { whole = Text("\(whole)\u{2009}") }
                    whole = Text("\(whole)\(Text(number).font(font).foregroundColor(Cockpit.Color.textSecondary))")
                }
            }
            previous = piece
        }
        return Group {
            if #available(macOS 15, *) {
                whole.textRenderer(CiteRenderer(fresh: fresh))
                    .backgroundPreferenceValue(Text.LayoutKey.self) { layouts in if platform == .ios { marks(layouts) } }
                    .overlayPreferenceValue(Text.LayoutKey.self) { layouts in capsules(layouts) }
            } else {
                whole
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    @available(macOS 15, *)
    private func marks(_ layouts: [Text.LayoutKey.AnchoredLayout]) -> some View {
        GeometryReader { proxy in
            ForEach(CiteRenderer.capsules(layouts.map { (proxy[$0.origin], $0.layout) })) { capsule in
                Capsule().fill(capsule.open ? Cockpit.Color.selection : Cockpit.Color.raised)
                    .frame(width: capsule.rect.width, height: capsule.rect.height)
                    .position(x: capsule.rect.midX, y: capsule.rect.midY)
            }
        }
    }

    @available(macOS 15, *)
    private func capsules(_ layouts: [Text.LayoutKey.AnchoredLayout]) -> some View {
        GeometryReader { proxy in
            ForEach(CiteRenderer.capsules(layouts.map { (proxy[$0.origin], $0.layout) })) { capsule in
                let face = Capsule().fill(Color.clear).contentShape(Capsule())
                Group {
                    if capsule.handles.count > 1 {
                        Menu {
                            ForEach(capsule.handles, id: \.self) { handle in
                                if let ref = refs?[handle] { Button(ref.said) { cite(handle) } }
                            }
                        } label: { face }
                        .menuIndicator(.hidden)
                        .accessibilityLabel("\(capsule.handles.count) more sources")
                        .help("\(capsule.handles.count) more sources")
                    } else {
                        Button { cite(capsule.handles[0]) } label: { face }
                            .accessibilityLabel("Source \(capsule.number)" + (refs?[capsule.handles[0]].map { ": " + $0.said } ?? ""))
                            .help(refs?[capsule.handles[0]]?.said ?? "")
                    }
                }
                .buttonStyle(.plain)
                .frame(width: capsule.rect.width, height: capsule.rect.height)
                .position(x: capsule.rect.midX, y: capsule.rect.midY)
                .disabled(refs == nil)
            }
        }
    }
}


struct Drawn {
    static let scheme = "lifestream-cite"

    enum Item { case block(Block), pictures([String]), voices([String]) }
    enum Detail: Hashable { case span(Int), cite(Int) }
    struct Block {
        enum Kind { case text([Run]), heading([Run]), code(AttributedString), rule, table([Row]) }
        let kind: Kind
        var list: List? = nil
        var quote = false
    }
    struct List: Equatable {
        let root: Int
        let depth: Int
        let marker: String
        let first: Bool
    }
    struct Row { let header: Bool; let cells: [[Run]] }
    enum Run {
        case words(AttributedString, InlinePresentationIntent, link: Bool)
        case cite([String], String, group: Int?)

        var unresolved: Bool {
            if case let .cite(handles, _, _) = self { handles.isEmpty } else { false }
        }
    }

    let items: [Item]
    let order: [Detail: Int]
    let person: [Detail: String]
    let model: [Detail: String]
    let seeing: Bool

    static let opening: Character = "\u{E100}"
    static let closing: Character = "\u{E101}"
    static let keyed: UInt32 = 0xF0000
    private static let unresolved = "\u{200B}"

    private static var cited: Regex<(Substring, Substring)> { /\[(r\d+(?:\s*,\s*r\d+)*)\]/ }
    private static var codeOrCited: Regex<(Substring, Substring?, Substring?, Substring?)> {
        /(`+)[\s\S]*?\1|\]\([^)\s]*\)|([ \t]*)((?:\[r\d+(?:\s*,\s*r\d+)*\][ \t]*)*\[r\d+(?:\s*,\s*r\d+)*\])/
    }
    private static var target: Regex<Substring> { /\]\([^)\n]*\)/ }
    private static var autolink: Regex<Substring> {
        /<(?:[A-Za-z][A-Za-z0-9+.\-]{1,31}:[^\s<>]*|[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)*)>/
    }
    private static let shownAlone = 2

    static func handles(of link: String) -> [String] {
        (link.dropFirst(scheme.count + 1).split(separator: ";", omittingEmptySubsequences: false).first ?? "").split(separator: ",").map(String.init)
    }

    static func group(of link: String) -> Int? {
        link.split(separator: ";").dropFirst().first.flatMap { Int($0) }
    }
    private static var unfinished: Regex<Substring> { /\[(?:r\d*(?:\s*,\s*(?:r\d*)?)*)?$/ }

    static func copied(_ markdown: String) -> String {
        citations(in: withoutSources(markdown)) { _, _, _ in "" }.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func citations(in text: String, _ put: (Substring, [String], Substring) -> String) -> String {
        var fenced = false
        return text.split(separator: "\n", omittingEmptySubsequences: false).map { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                fenced.toggle()
                return String(line)
            }
            if fenced { return String(line) }
            return String(line.replacing(codeOrCited) { match in
                guard let list = match.output.3 else { return String(match.output.0) }
                var handles: [String] = []
                for handle in list.matches(of: /r\d+/).map({ String($0.output) }) where !handles.contains(handle) { handles.append(handle) }
                return put(match.output.2 ?? "", handles, list)
            })
        }.joined(separator: "\n")
    }

    init(_ markdown: String, refs: [String: AskRef]?, cut: Bool = false, seen: [AskSeen.Span]? = nil) {
        let plain = Built(markdown, refs: refs, cut: cut)
        if let seen, let marking = Marking(markdown, seen) {
            let keyed = Built(marking.text, refs: refs, cut: cut)
            if Self.shape(keyed.items) == Self.shape(plain.items), keyed.keys == Set(marking.model.indices) {
                items = keyed.items
                order = keyed.order
                person = keyed.person
                model = marking.model.enumerated().reduce(into: keyed.model) { model, unit in model[.span(unit.offset)] = unit.element }
                seeing = true
                return
            }
        }
        items = plain.items
        order = plain.order
        person = plain.person
        model = plain.model
        seeing = false
    }

    private struct Marking {
        let text: String
        let model: [String]

        init?(_ text: String, _ spans: [AskSeen.Span]) {
            guard AskSeen.fits(text, spans) else { return nil }
            let units = Array(text.utf16)
            func offsets(_ regex: Regex<Substring>) -> [Range<Int>] {
                text.matches(of: regex).map { match in
                    text.utf16.distance(from: text.startIndex, to: match.range.lowerBound)..<text.utf16.distance(from: text.startIndex, to: match.range.upperBound)
                }
            }
            let targets = offsets(Drawn.target)
            let autolinks = offsets(Drawn.autolink)
            var groups: [(range: Range<Int>, spans: [AskSeen.Span])] = []
            for span in spans {
                if targets.contains(where: { $0.lowerBound <= span.start && span.end <= $0.upperBound }) { continue }
                guard span.end > span.start else { return nil }
                var range = span.start..<span.end
                for link in autolinks where link.overlaps(range) {
                    range = min(range.lowerBound, link.lowerBound)..<max(range.upperBound, link.upperBound)
                }
                if let last = groups.last, range.lowerBound < last.range.upperBound {
                    groups[groups.count - 1] = (min(last.range.lowerBound, range.lowerBound)..<max(last.range.upperBound, range.upperBound),
                                                last.spans + [span])
                } else {
                    groups.append((range, [span]))
                }
            }
            var out: [UInt16] = []
            var at = 0
            var model: [String] = []
            for (index, group) in groups.enumerated() {
                out += units[at..<group.range.lowerBound]
                out += Array("\(Drawn.opening)\(Character(Unicode.Scalar(Drawn.keyed + UInt32(index))!))".utf16)
                out += units[group.range]
                out += Array(String(Drawn.closing).utf16)
                var said: [UInt16] = []
                var from = group.range.lowerBound
                for span in group.spans {
                    said += units[from..<span.start] + Array(span.said.utf16)
                    from = span.end
                }
                said += units[from..<group.range.upperBound]
                model.append(String(decoding: said, as: UTF16.self))
                at = group.range.upperBound
            }
            out += units[at...]
            self.text = String(decoding: out, as: UTF16.self)
            self.model = model
        }
    }

    private struct Built {
        var items: [Item] = []
        var order: [Detail: Int] = [:]
        var person: [Detail: String] = [:]
        var model: [Detail: String] = [:]
        var keys: Set<Int> = []

        init(_ markdown: String, refs: [String: AskRef]?, cut: Bool) {
            let text = Drawn.withoutSources(cut || refs == nil ? markdown.replacing(Drawn.unfinished, with: "") : markdown)
            var numbers: [String: Int] = [:]
            var placed: Set<String> = []
            var standing: [String: String] = [:]
            var groups = 0
            for source in Drawn.blocks(of: text) {
                var photos: [String] = []
                var notes: [String] = []
                let linked = Drawn.citations(in: source) { space, handles, said in
                    var shown: [String] = []
                    for handle in handles where refs == nil || refs?[handle] != nil {
                        let stands = refs?[handle]?.stands.map { source in
                            if standing[source] == nil { standing[source] = handle }
                            return standing[source] ?? handle
                        } ?? handle
                        if !shown.contains(stands) { shown.append(stands) }
                    }
                    let cited = shown.map { handle in
                        let n = numbers[handle] ?? numbers.count + 1
                        numbers[handle] = n
                        if let voice = refs?[handle]?.voice {
                            if placed.insert("voice \(voice.record)").inserted { notes.append(handle) }
                        } else if refs?[handle]?.image == true, placed.insert(handle).inserted {
                            photos.append(handle)
                        }
                        return n
                    }
                    let group = groups
                    groups += 1
                    person[.cite(group)] = cited.first.map { "\($0)" } ?? ""
                    model[.cite(group)] = String(said)
                    guard !shown.isEmpty else { return String(space) + "[\(Drawn.unresolved)](\(Drawn.scheme):;\(group))" }
                    let alone = zip(cited, shown).prefix(Drawn.shownAlone).map { n, handle in "[\(n)](\(Drawn.scheme):\(handle);\(group))" }.joined()
                    let rest = shown.dropFirst(Drawn.shownAlone)
                    return String(space) + alone + (rest.isEmpty ? "" : "[+\(rest.count)](\(Drawn.scheme):\(rest.joined(separator: ","));\(group))")
                }
                items += Drawn.parse(linked).map(Item.block)
                if !photos.isEmpty { items.append(.pictures(photos)) }
                if !notes.isEmpty { items.append(.voices(notes)) }
            }
            for case let .block(block) in items {
                switch block.kind {
                case let .text(runs), let .heading(runs): note(runs)
                case let .table(rows): for row in rows { for cell in row.cells { note(cell) } }
                case let .code(code): code.runs[SeenKey.self].forEach { key, _ in if let key { keys.insert(key) } }
                case .rule: break
                }
            }
        }

        private mutating func note(_ runs: [Run]) {
            for run in runs {
                switch run {
                case let .words(words, _, _):
                    for (key, range) in words.runs[SeenKey.self] {
                        guard let key else { continue }
                        keys.insert(key)
                        if order[.span(key)] == nil { order[.span(key)] = order.count }
                        person[.span(key), default: ""] += String(words[range].characters)
                    }
                case let .cite(_, _, group):
                    if let group, model[.cite(group)] != nil, order[.cite(group)] == nil { order[.cite(group)] = order.count }
                }
            }
        }
    }

    private static func shape(_ items: [Item]) -> [String] {
        func words(_ words: AttributedString) -> String {
            String(words.characters) + "\u{1}" + words.runs[AttributeScopes.FoundationAttributes.LinkAttribute.self]
                .map { link, _ in link?.absoluteString ?? "" }.joined(separator: "\u{1}")
        }
        func runs(_ runs: [Run]) -> String {
            runs.map { run in
                switch run {
                case let .words(said, intent, link): "w\(intent.rawValue) \(link) " + words(said)
                case let .cite(handles, number, group): "c\(handles) \(number) \(group ?? -1)"
                }
            }.joined(separator: "\u{2}")
        }
        return items.map { item in
            switch item {
            case let .pictures(handles): return "p\(handles)"
            case let .voices(handles): return "v\(handles)"
            case let .block(block):
                let head = "\(block.list.map { "\($0.root) \($0.depth) \($0.marker) \($0.first)" } ?? "-") \(block.quote) "
                switch block.kind {
                case let .text(said): return "t" + head + runs(said)
                case let .heading(said): return "h" + head + runs(said)
                case let .code(code): return "k" + head + words(code)
                case .rule: return "r" + head
                case let .table(rows): return "b" + head + rows.map { "\($0.header)" + $0.cells.map(runs).joined(separator: "\u{3}") }.joined(separator: "\u{4}")
                }
            }
        }
    }

    static func unmarked(_ parsed: AttributedString) -> AttributedString {
        var out = AttributedString()
        var key: Int?
        var opened = false
        for run in parsed.runs {
            var buffer = ""
            func flush() {
                guard !buffer.isEmpty else { return }
                var piece = AttributedString(buffer, attributes: run.attributes)
                piece[SeenKey.self] = key
                out.append(piece)
                buffer = ""
            }
            for character in parsed[run.range].characters {
                if opened {
                    opened = false
                    if let scalar = character.unicodeScalars.first, scalar.value >= keyed, character.unicodeScalars.count == 1 {
                        key = Int(scalar.value - keyed)
                        continue
                    }
                }
                if character == opening {
                    flush()
                    opened = true
                    continue
                }
                if character == closing {
                    flush()
                    key = nil
                    continue
                }
                buffer.append(character)
            }
            flush()
        }
        return out
    }

    private static func blocks(of text: String) -> [String] {
        var blocks: [String] = []
        var block: [Substring] = []
        var fenced = false
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { fenced.toggle() }
            if !fenced && trimmed.isEmpty {
                if !block.isEmpty { blocks.append(block.joined(separator: "\n")) }
                block = []
            } else {
                block.append(line)
            }
        }
        if !block.isEmpty { blocks.append(block.joined(separator: "\n")) }
        return blocks
    }

    private static func withoutSources(_ text: String) -> String {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let sources = /^\W*[Ss]ources?\W*:/
        let onlyHandles = { (line: String) in line.replacing(cited, with: "").allSatisfy { " \t-*•·,;.".contains($0) } }
        guard var end = lines.indices.last else { return text }
        while end >= 0, lines[end].trimmingCharacters(in: .whitespaces).isEmpty { end -= 1 }
        var at = end
        while at >= 0, !lines[at].trimmingCharacters(in: .whitespaces).isEmpty, lines[at].firstMatch(of: sources) == nil,
              onlyHandles(lines[at]) { at -= 1 }
        guard at >= 0, lines[at].firstMatch(of: sources) != nil, onlyHandles(lines[at].replacing(sources, with: "")) else { return text }
        let named = lines[at...end].joined(separator: " ").matches(of: cited).map { String($0.output.0) }
        let rest = lines[..<at].joined(separator: "\n").replacing(/\s+$/, with: "")
        var missing: [String] = []
        for cite in named where !rest.contains(cite) && !missing.contains(cite) { missing.append(cite) }
        return missing.isEmpty ? rest : rest + " " + missing.joined(separator: " ")
    }

    private static func parse(_ markdown: String) -> [Block] {
        guard let read = try? AttributedString(markdown: markdown, options: .init(
            interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible)) else {
            return [Block(kind: .text([.words(unmarked(AttributedString(markdown)), [], link: false)]))]
        }
        let parsed = unmarked(read)
        var blocks: [Block] = []
        var runs: [Run] = []
        var table: (id: Int, rows: [Row], row: Int?, cells: [[Run]], header: Bool)?
        var itemsSeen: Set<Int> = []

        func flushTable() {
            guard var open = table else { return }
            if open.row != nil { open.rows.append(Row(header: open.header, cells: open.cells)) }
            blocks.append(Block(kind: .table(open.rows)))
            table = nil
        }
        func flush(_ intent: PresentationIntent?) {
            guard let intent, let leaf = intent.components.first, !runs.isEmpty || leaf.kind == .thematicBreak else { return }
            defer { runs = [] }
            if let tableId = intent.components.first(where: { if case .table = $0.kind { true } else { false } })?.identity {
                let rowComponent = intent.components.first { switch $0.kind { case .tableRow, .tableHeaderRow: true; default: false } }
                if table?.id != tableId { flushTable(); table = (tableId, [], nil, [], false) }
                if table?.row != rowComponent?.identity {
                    if let open = table, open.row != nil { table?.rows.append(Row(header: open.header, cells: open.cells)) }
                    table?.row = rowComponent?.identity
                    table?.cells = []
                    table?.header = rowComponent?.kind == .tableHeaderRow
                }
                table?.cells.append(runs)
                return
            }
            flushTable()
            var block: Block
            switch leaf.kind {
            case .header: block = Block(kind: .heading(runs))
            case .codeBlock:
                var code = runs.reduce(into: AttributedString()) { code, run in if case let .words(words, _, _) = run { code.append(words) } }
                if code.characters.last == "\n" { code.characters.removeLast() }
                block = Block(kind: .code(code))
            case .thematicBreak: block = Block(kind: .rule)
            default: block = Block(kind: .text(runs))
            }
            block.quote = intent.components.contains { $0.kind == .blockQuote }
            if let index = intent.components.firstIndex(where: { if case .listItem = $0.kind { true } else { false } }),
               case let .listItem(ordinal) = intent.components[index].kind {
                let ordered = intent.components[(index + 1)...].first { $0.kind == .orderedList || $0.kind == .unorderedList }?.kind == .orderedList
                let lists = intent.components.filter { $0.kind == .orderedList || $0.kind == .unorderedList }
                block.list = List(root: lists.last?.identity ?? 0, depth: lists.count, marker: ordered ? "\(ordinal)." : "•",
                                  first: itemsSeen.insert(intent.components[index].identity).inserted)
            }
            blocks.append(block)
        }

        var intentOfLeaf: PresentationIntent?
        let attributes = parsed.runs[AttributeScopes.FoundationAttributes.PresentationIntentAttribute.self,
                                     AttributeScopes.FoundationAttributes.InlinePresentationIntentAttribute.self,
                                     AttributeScopes.FoundationAttributes.LinkAttribute.self]
        for (intent, inline, link, range) in attributes {
            let id = intent?.components.first?.identity
            if id != intentOfLeaf?.components.first?.identity {
                flush(intentOfLeaf)
                intentOfLeaf = intent
            }
            var words = AttributedString(parsed[range])
            words.inlinePresentationIntent = nil
            words.presentationIntent = nil
            if let link, link.scheme == scheme {
                runs.append(.cite(handles(of: link.absoluteString), String(words.characters), group: group(of: link.absoluteString)))
            } else {
                runs.append(.words(words, inline ?? [], link: link != nil))
            }
        }
        flush(intentOfLeaf)
        flushTable()
        return blocks
    }
}

extension Drawn {
    enum Piece {
        case words(AttributedString, InlinePresentationIntent, link: Bool)
        case detail(Detail, SeenClock.Look)
        case cite([String], String)
    }

    static func pieces(_ runs: [Run], shown: Shown?, closeUp: Bool) -> [Piece] {
        var pieces: [Piece] = []
        var drawn: Set<Detail> = []
        for run in shown?.raw == true ? runs : closedUp(stopsFirst(runs.filter { !$0.unresolved }), closeUp) {
            switch run {
            case let .words(words, intent, link):
                guard let shown else {
                    pieces.append(.words(words, intent, link: link))
                    continue
                }
                for (key, range) in words.runs[SeenKey.self] {
                    guard let key, let look = shown.look(.span(key)), look != .person else {
                        pieces.append(.words(AttributedString(words[range]), intent, link: link))
                        continue
                    }
                    if drawn.insert(.span(key)).inserted { pieces.append(.detail(.span(key), look)) }
                }
            case let .cite(handles, number, group):
                if let shown, let group, let look = shown.look(.cite(group)), look != .person {
                    if drawn.insert(.cite(group)).inserted { pieces.append(.detail(.cite(group), look)) }
                } else if !handles.isEmpty {
                    pieces.append(.cite(handles, number))
                }
            }
        }
        return pieces
    }

    private static func closedUp(_ runs: [Run], _ closeUp: Bool) -> [Run] {
        guard closeUp else { return runs }
        var runs = runs
        for index in runs.indices.dropFirst() {
            guard case .cite = runs[index], case let .words(before, intent, link) = runs[index - 1] else { continue }
            var words = before
            while words.characters.last?.isWhitespace == true { words.characters.removeLast() }
            runs[index - 1] = .words(words, intent, link: link)
        }
        return runs
    }

    private static func stopsFirst(_ runs: [Run]) -> [Run] {
        var runs = runs
        for index in runs.indices.dropLast() {
            guard case .cite = runs[index], case let .words(after, intent, link) = runs[index + 1],
                  let stop = after.characters.first, ".,;:!?".contains(stop),
                  let last = runs[..<index].lastIndex(where: { if case .words = $0 { true } else { false } }),
                  case let .words(before, priorIntent, priorLink) = runs[last] else { continue }
            var rest = after
            rest.characters.removeFirst()
            var joined = before
            while joined.characters.last?.isWhitespace == true { joined.characters.removeLast() }
            joined.append(AttributedString(String(stop)))
            runs[last] = .words(joined, priorIntent, link: priorLink)
            runs[index + 1] = .words(rest, intent, link: link)
        }
        return runs
    }
}


@available(macOS 15, *)
struct CiteMark: TextAttribute {
    let handles: [String]
    let number: String
    let open: Bool
    let apart: CGFloat
}

@available(macOS 15, *)
struct CiteRenderer: TextRenderer {
    var fresh: [AskTrace.Fresh] = []

    struct Placed: Identifiable {
        let id: Int
        let handles: [String]
        let number: String
        let open: Bool
        let rect: CGRect
        let runs: [Text.Layout.Run]
    }

    func draw(layout: Text.Layout, in context: inout GraphicsContext) {
        SeenFill.draw(layout, in: &context)
        let glyphs = fresh.isEmpty ? 0 : layout.reduce(0) { sum, line in sum + line.reduce(0) { $0 + ($1[CiteMark.self] == nil ? $1.count : 0) } }
        var drawn = 0
        for line in layout {
            for run in line where run[CiteMark.self] == nil {
                guard !fresh.isEmpty else {
                    context.draw(run)
                    continue
                }
                for slice in run {
                    let shown = Self.shown(fromEnd: glyphs - 1 - drawn, fresh)
                    drawn += 1
                    var faded = context
                    faded.opacity = shown
                    faded.draw(slice)
                }
            }
        }
        for capsule in Self.capsules([(.zero, layout)]) { draw(capsule, in: &context) }
    }

    static func shown(fromEnd glyph: Int, _ fresh: [AskTrace.Fresh]) -> Double {
        var counted = 0
        for word in fresh.reversed() {
            counted += word.visible
            if glyph < counted { return 1 - (1 - word.shown) * (1 - word.shown) }
        }
        return 1
    }

    static func capsules(_ layouts: [(origin: CGPoint, layout: Text.Layout)]) -> [Placed] {
        var placed: [Placed] = []
        for (origin, layout) in layouts {
            for line in layout {
                var cited: [Text.Layout.Run] = []
                func close() {
                    guard let mark = cited.first?[CiteMark.self] else { return }
                    let bounds = cited.map(\.typographicBounds.rect).reduce(CGRect.null) { $0.union($1) }.insetBy(dx: mark.apart / 2, dy: 0)
                        .offsetBy(dx: mark.apart / 2 + origin.x, dy: origin.y)
                    let height = Cockpit.Size.citation
                    let width = max(height, bounds.width)
                    placed.append(Placed(id: placed.count, handles: mark.handles, number: mark.number, open: mark.open,
                                         rect: CGRect(x: bounds.midX - width / 2, y: bounds.midY - height / 2, width: width, height: height),
                                         runs: cited))
                    cited = []
                }
                for run in line {
                    if let mark = run[CiteMark.self], let first = cited.first?[CiteMark.self], first.handles == mark.handles {
                        cited.append(run)
                        continue
                    }
                    close()
                    if run[CiteMark.self] != nil { cited = [run] }
                }
                close()
            }
        }
        return placed
    }

    private func draw(_ capsule: Placed, in context: inout GraphicsContext) {
        let shape = Capsule().path(in: capsule.rect)
        context.fill(shape, with: .color(Cockpit.Color.raised))
        if capsule.open { context.fill(shape, with: .color(Cockpit.Color.selection)) }
        context.drawLayer { layer in
            for run in capsule.runs { layer.draw(run) }
            layer.blendMode = .sourceIn
            layer.fill(Path(capsule.rect), with: .color(capsule.open ? Cockpit.Color.text : Cockpit.Color.textSecondary))
        }
    }
}


enum SeenKey: AttributedStringKey {
    typealias Value = Int
    static let name = "lifestream.seen"
}

struct Shown {
    let showing: SeenShowing
    let after: Int
    let drawn: Drawn

    var raw: Bool {
        showing.on || showing.clock.map { showing.now < $0.settles(after + drawn.order.count) } == true
    }

    func look(_ detail: Drawn.Detail) -> SeenClock.Look? {
        guard let order = drawn.order[detail], let model = drawn.model[detail] else { return nil }
        return showing.look(after + order, from: drawn.person[detail] ?? "", to: model)
    }

    func text(_ detail: Drawn.Detail, look: SeenClock.Look) -> Text {
        let kind: SeenShowing.Kind = if case .span = detail { .chip } else { .plain }
        return showing.text(after + (drawn.order[detail] ?? 0), person: drawn.person[detail] ?? "", model: drawn.model[detail] ?? "",
                            kind: kind, look: look)
    }

    func code(_ code: AttributedString, on: Bool) -> String {
        guard on else { return String(code.characters) }
        var said: Set<Int> = []
        return code.runs[SeenKey.self].map { key, range in
            guard let key else { return String(code[range].characters) }
            return said.insert(key).inserted ? drawn.model[.span(key)] ?? "" : ""
        }.joined()
    }
}

private struct Pictures<Picture: View>: View {
    let handles: [(String, AskRef)]
    let cite: (String) -> Void
    let picture: (String, AskRef, AskFit) -> Picture

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous)
        switch handles.count {
        case 1:
            button(0) { picture(handles[0].0, handles[0].1, .own).frame(maxHeight: 320) }
                .clipShape(shape)
                .frame(maxWidth: .infinity, alignment: .leading)
        case 2...3:
            HStack(spacing: Cockpit.Space.s1) {
                ForEach(handles.indices, id: \.self) { index in
                    button(index) { tile(index).frame(maxWidth: .infinity).frame(height: 160) }
                }
            }
        default:
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: Cockpit.Space.s1), count: 3), spacing: Cockpit.Space.s1) {
                ForEach(0..<min(6, handles.count), id: \.self) { index in
                    button(index) {
                        Color.clear
                            .aspectRatio(1, contentMode: .fit)
                            .overlay {
                                if index == 5 && handles.count > 6 {
                                    Text("+\(handles.count - 5)").cockpit(.title2).foregroundStyle(Cockpit.Color.text)
                                } else {
                                    tile(index)
                                }
                            }
                    }
                }
            }
        }
    }

    private func tile(_ index: Int) -> some View {
        picture(handles[index].0, handles[index].1, .fill).clipped()
    }

    private func button<Label: View>(_ index: Int, @ViewBuilder label: () -> Label) -> some View {
        let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous)
        return Button { cite(handles[index].0) } label: {
            label().background(Cockpit.Color.raised).clipShape(shape).contentShape(shape)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(index == 5 && handles.count > 6 ? "\(handles.count - 5) more photos" : handles[index].1.said)
    }
}

extension AskAnswer where Voice == EmptyView {
    public init(_ trace: AskTrace, refs: [String: AskRef]?, open: String? = nil, end: AskEnd = .done,
                seen: AskSeen? = nil, modelView: Binding<Bool>? = nil, feedback: AskFeedback? = nil,
                cite: @escaping (String) -> Void, @ViewBuilder picture: @escaping (String, AskRef, AskFit) -> Picture) {
        self.init(trace, refs: refs, open: open, end: end, seen: seen, modelView: modelView, feedback: feedback, cite: cite,
                  picture: picture) { _, _ in EmptyView() }
    }
}
