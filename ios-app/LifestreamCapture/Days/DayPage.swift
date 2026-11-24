import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct DayPage: View {
    @Environment(\.rootBarFoot) private var foot
    @ObservedObject var model: DayModel
    let isToday: Bool
    let current: Bool
    var near = false
    let selected: String?
    let focus: String?
    let openRow: (_ row: String, _ focus: String?) -> Void
    let focused: () -> Void
    let photos: ([String], Int) -> Void
    let first: String?
    let go: (String) -> Void
    let choose: () -> Void

    @ObservedObject private var days = DaysModel.shared
    @EnvironmentObject private var places: PlacesModel
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var position = ScrollPosition(edge: .top)
    @State private var heads = HeldHead()
    @State private var restored = false
    @State private var naming: NamingStart?
    @State private var namingOver: [PlacesSnapshot.Spot] = []

    private struct Turn: Equatable {
        let reading: Bool
        let current: Bool
        let namings: Int
        let clock: DayReading.Turned
    }

    private var reading: Bool { (current || near) && scenePhase == .active }

    var body: some View {
        ScrollViewReader { proxy in page(proxy) }
    }

    private func page(_ proxy: ScrollViewProxy) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                head(proxy)
                list
                side
            }
            .padding(.bottom, Cockpit.Space.s8)
            .animation(.easeOut(duration: Cockpit.Duration.fast), value: model.phase == .loading)
        }
        .scrollPosition($position)
        .barTitleScroll(current: current)
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { _, offset in
            if restored { model.offset = max(0, offset) }
        }
        .groundColor(Cockpit.Color.canvas)
        .accessibilityIdentifier("days.day")
        .accessibilityValue(AppRuntime.isUITesting ? Self.said(model.phase) : "")
        .environment(\.skeletonForced, current ? nil : 0)
        .onChange(of: model.page, initial: true) { _, page in
            guard page != nil else { return }
            restore()
            if current, let page { unfoldForDesign(page) }
            reveal()
        }
        .task(id: Turn(reading: reading, current: current, namings: model.namingTurns, clock: days.turned)) {
            guard reading else { return }
            let days = DaysModel.shared
            let generation = AppRuntime.isUITesting ? CannedHome.Asks.shared.began(model.day, front: current) : 0
            defer { if AppRuntime.isUITesting { CannedHome.Asks.shared.ended(model.day, generation, cancelled: Task.isCancelled) } }
            guard current else {
                if model.page == nil { await days.read(model) }
                return
            }
            days.inFront = model.day
            await days.read(model)
            await places.refreshBook()
            var followed = 0
            while !Task.isCancelled {
                if !model.naming.isEmpty {
                    try? await Task.sleep(for: DayModel.namingWait(after: followed))
                    guard !Task.isCancelled else { break }
                    followed += 1
                    await model.readPage()
                    continue
                }
                if model.rendering {
                    try? await Task.sleep(for: DayModel.renderingAgain)
                    guard !Task.isCancelled else { break }
                    await days.read(model)
                    continue
                }
                guard let page = model.page, let again = DayReading.again(page, now: AppClock.now) else { break }
                try? await Task.sleep(for: .seconds(max(1, again.timeIntervalSince(AppClock.now))))
                guard !Task.isCancelled else { break }
                await days.read(model)
            }
        }
        .readsAgain(failed: { reading ? model.failure : nil }) {
            await DaysModel.shared.read(model)
        }
        .fullScreenCover(item: $naming) { start in
            NamingWalk(model: places, start: start) { [over = namingOver, model] named in
                model.named(Set(over.filter { named.contains($0.id) }.compactMap(\.key)))
            }
        }
    }


    @ViewBuilder private func head(_ proxy: ScrollViewProxy) -> some View {
        let figures = figureValues
        DayHead(day: model.day, word: days.relative(model.day),
                today: days.today, open: choose)
        if current, let foot { foot.padding(.top, Cockpit.Space.s2) }
        if figuresReading {
            FigureRow(Self.figureShapes)
                .padding(.top, Cockpit.Space.s4)
                .reading(true)
                .accessibilityHidden(true)
                .transition(.identity)
        } else if !figures.isEmpty {
            FigureRow(figures)
                .padding(.top, Cockpit.Space.s4)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("day.figures")
                .transition(.opacity)
        }
        if let failed {
            ReadLack(failed, lacks: first == nil && isToday ? "Your days aren't on this iPhone yet." : "This day isn't on this iPhone yet.",
                     words: Self.sentence(failed), lacking: "day.lacks") {
                Task { await DaysModel.shared.read(model) }
            }
            .padding(.horizontal, Cockpit.Gap.edge)
            .padding(.top, Cockpit.Space.s2)
        }
        if model.phase == .shown {
            PageNote(drawn: model.drawn)
                .padding(.horizontal, Cockpit.Gap.edge)
                .padding(.top, Cockpit.Space.s2)
        }
        if isToday && current {
            QuestionCards()
                .padding(.horizontal, Cockpit.Gap.edge)
        }
    }

    private var failed: LifeReader.Failure? {
        if case .failed(let failure) = model.phase { failure } else { nil }
    }

    private var figuresReading: Bool { model.page == nil && model.phase == .loading }

    private static let figureShapes: [FigureRow.Value] = [.init("0h 00m", "asleep"), .init("0,000", "steps"), .init("0,000", "sent")]

    private var figureValues: [FigureRow.Value] {
        (model.page?.side.figures ?? []).map { FigureRow.Value($0.value, $0.words) }
    }

    private var lead: CGFloat { Cockpit.Space.s3 }


    @ViewBuilder private var list: some View {
        switch model.phase {
        case .loading:
            VStack(alignment: .leading, spacing: 0) {
                Color.clear.frame(height: lead)
                FoldReading()
                WaitLine()
            }
            .reading(true)
            .transition(.identity)
        case .unwritten:
            if let words = model.page?.beforeHome {
                BeforeHome(words: words, first: first) { if let first { go(first) } }
            } else {
                EmptyState(.days, title: model.page?.line ?? "Nothing recorded yet", line: "It fills in as your devices send it.").centred()
            }
        case .failed:
            EmptyView()
        case .shown:
            if let page = model.page {
                DayList(layout: DayLayout.of(page, isOpen: model.isOpen, lead: lead), context: context(page), act: actions(page))
            }
        }
    }

    private func context(_ page: HomeLink.Pages.Day) -> FoldContext {
        FoldContext(page: page, today: days.today, selected: selected, lit: model.lit, clock: days.drawnBy,
                    naming: DayList.naming(page, toName: places.toName))
    }

    private func actions(_ page: HomeLink.Pages.Day) -> FoldActions {
        FoldActions(
            toggle: { key, fromHead in
                let opening = !model.isOpen(key, folded: DayModel.folded(key, in: page))
                let held = fromHead && !opening && heads.holds(key)
                withAnimation(motion(opening: opening)) {
                    model.toggled.formSymmetricDifference([key])
                    if held { position.scrollTo(id: "head:\(key)", anchor: .top) }
                }
            },
            toggleEvery: {
                let keys = page.chapters.filter { $0.kind != .move && DayReading.opens($0) }.map { ($0.key, $0.folded) }
                    + (page.also.map { [(DayReading.also, $0.folded)] } ?? [])
                let every = keys.allSatisfy { model.isOpen($0.0, folded: $0.1) }
                withAnimation(motion(opening: !every)) {
                    for (key, folded) in keys {
                        if every == folded { model.toggled.remove(key) } else { model.toggled.insert(key) }
                    }
                }
            },
            open: { open($0, in: page) },
            photo: { shots, at in photos(shots.map(\.hash), at) },
            held: { [heads] key, pinned in heads.set(key, pinned) },
            name: { spot in
                namingOver = places.toName
                naming = NamingStart(key: spot.key)
            }
        )
    }

    private func reveal() {
        guard let focus, model.page != nil else { return }
        openRow(focus, nil)
        focused()
    }

    private func open(_ row: String, in page: HomeLink.Pages.Day) {
        guard let focus = DayReading.row(row, in: page)?.focus else { return }
        openRow(row, focus)
    }

    private func motion(opening: Bool) -> Animation {
        if reduceMotion { return .easeOut(duration: Cockpit.Duration.fast) }
        return opening ? Cockpit.Ease.out(Cockpit.Duration.open) : Cockpit.Ease.inOut(Cockpit.Duration.fold)
    }

    private func scroll(to row: String, anchor: UnitPoint) {
        Task { @MainActor in
            await Task.yield()
            withAnimation(reduceMotion ? nil : Cockpit.Ease.out(Cockpit.Duration.base)) { position.scrollTo(id: row, anchor: anchor) }
            model.lit = row
            try? await Task.sleep(for: .seconds(Cockpit.Duration.draw))
            guard model.lit == row else { return }
            withAnimation(.easeOut(duration: Cockpit.Duration.fast)) { model.lit = nil }
        }
    }

    private func unfoldForDesign(_ page: HomeLink.Pages.Day) {
        let arguments = ProcessInfo.processInfo.arguments
        guard AppRuntime.isUITesting, !Self.unfolded, let at = arguments.firstIndex(of: "--ui-test-unfold"), at + 1 < arguments.count
        else { return }
        Self.unfolded = true
        let parts = arguments[at + 1].split(separator: ":")
        if parts.first == "end" {
            Task { @MainActor in
                for _ in 0..<6 {
                    try? await Task.sleep(for: .seconds(0.6))
                    position.scrollTo(edge: .bottom)
                }
            }
            return
        }
        let heads = page.chapters.filter { $0.kind == .stay || $0.kind == .none }
        guard let index = parts.first.flatMap({ Int($0) }), heads.indices.contains(index), heads[index].kind == .stay else { return }
        let chapter = heads[index]
        let hour = chapter.blocks.first { $0.kind == .hour }
        let keys = [chapter.key] + (hour.map { [$0.key] } ?? [])
        let steps: [(Set<String>, Bool)] = parts.count > 1
            ? [([chapter.key], true), (Set(keys), true), ([chapter.key], false), ([], false)]
            : [(Set(keys), true)]
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(parts.count > 1 ? 2.5 : 0.5))
            withAnimation(reduceMotion ? nil : Cockpit.Ease.out(Cockpit.Duration.base)) {
                position.scrollTo(id: "head:\(chapter.key)", anchor: .top)
            }
            for (open, opening) in steps {
                try? await Task.sleep(for: .seconds(1.5))
                withAnimation(motion(opening: opening)) {
                    model.toggled.subtract(keys)
                    model.open(open, in: page)
                }
            }
        }
    }

    @MainActor private static var unfolded = false

    private func restore() {
        guard !restored else { return }
        restored = true
        if model.offset > 0 { position.scrollTo(y: model.offset) }
    }


    @ViewBuilder private var side: some View {
        if model.phase == .shown, let page = model.page {
            DaySide(side: page.side, reveal: { rows in reveal(rows, in: page) }, openMoment: { open($0, in: page) })
        }
    }

    private func reveal(_ rows: [String], in page: HomeLink.Pages.Day) {
        let placed = rows.compactMap { DayReading.place(of: $0, in: page) }
        withAnimation(motion(opening: true)) { model.open(Set(placed.flatMap { [$0.chapter] + ($0.block.map { [$0] } ?? []) }), in: page) }
        let shown = Set(placed.map(\.row))
        guard let first = DayReading.rows(of: page).map(\.key).first(where: shown.contains) ?? placed.first?.row else { return }
        if page.chapters.contains(where: { $0.key == first }) {
            Task { @MainActor in
                await Task.yield()
                withAnimation(reduceMotion ? nil : Cockpit.Ease.out(Cockpit.Duration.base)) { position.scrollTo(id: "head:\(first)", anchor: .top) }
            }
        } else {
            scroll(to: first, anchor: .top)
        }
    }

    private static func said(_ phase: DayModel.Phase) -> String {
        switch phase {
        case .loading: "reading"
        case .shown: "shown"
        case .unwritten: "unwritten"
        case .failed: "failed"
        }
    }

    private static func sentence(_ failure: LifeReader.Failure) -> String? {
        switch failure {
        case .reach, .busy, .unpaired: nil
        case .missing, .refused, .failed, .unknown: "Lifestream could not send this day."
        }
    }
}

private struct BeforeHome: View {
    let words: String
    let first: String?
    let open: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s1) {
            Text(words).cockpit(Cockpit.Style.iosSubhead).foregroundStyle(Cockpit.Color.textSecondary)
            if let first {
                Button(action: open) {
                    let date = Text(Words.shortDay(first, today: DaysModel.shared.today))
                        .foregroundStyle(Cockpit.Color.text).underline()
                    Text("Lifestream begins \(date)")
                        .cockpit(Cockpit.Style.iosFootnote)
                        .foregroundStyle(Cockpit.Color.textTertiary)
                        .frame(minHeight: 44, alignment: .leading)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("day.first")
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, Cockpit.Gap.edge)
        .padding(.top, Cockpit.Space.s3)
    }
}

private final class HeldHead: @unchecked Sendable {
    private let lock = NSLock()
    private var key: String?

    func set(_ head: String, _ pinned: Bool) {
        lock.withLock {
            if pinned { key = head } else if key == head { key = nil }
        }
    }

    func holds(_ head: String) -> Bool {
        lock.withLock { key == head }
    }
}
