import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct LifeGate<Root: View>: View {
    let tab: AppNavigation.Tab
    @ViewBuilder let root: () -> Root
    private var navigation: AppNavigation { .shared }
    @ObservedObject private var reach = AppRuntime.shared.reach

    init(_ tab: AppNavigation.Tab, @ViewBuilder root: @escaping () -> Root) {
        self.tab = tab
        self.root = root
    }

    var body: some View {
        if reach.snapshot.reach == .unpaired {
            UnpairedSection(tab: tab)
        } else {
            NavigationStack(path: navigation.path(tab)) {
                root().environment(\.rootBarFoot, AnyView(HomeStrip())).lifeDestinations().streamsButton()
            }
            .environment(\.reachLacks, reach.lacks)
        }
    }
}

struct LockedApp: View {
    @ObservedObject private var lock = LifeLock.shared

    var body: some View {
        LockCover(offersUnlock: lock.face == .offers) { Task { await lock.unlock() } }
    }
}

struct LockCover: View {
    let offersUnlock: Bool
    let unlock: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: Cockpit.Space.s6)
            Image(systemName: "faceid")
                .font(.system(size: 34, weight: .regular))
                .foregroundStyle(Cockpit.Color.text)
                .frame(width: 72, height: 72)
                .background(Circle().fill(Cockpit.Color.surface))
                .accessibilityHidden(true)
            Text("Lifestream is locked")
                .cockpit(Cockpit.Style.iosTitle2)
                .foregroundStyle(Cockpit.Color.text)
                .multilineTextAlignment(.center)
                .padding(.top, Cockpit.Space.s5)
                .accessibilityAddTraits(.isHeader)
            Button("Unlock", action: unlock)
                .buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
                .accessibilityIdentifier("life.unlock")
                .padding(.top, Cockpit.Space.s8)
                .opacity(offersUnlock ? 1 : 0)
                .allowsHitTesting(offersUnlock)
                .accessibilityHidden(!offersUnlock)
            Spacer(minLength: Cockpit.Space.s6)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, Cockpit.Gap.edge)
        .groundColor(Cockpit.Color.canvas)
    }
}

private struct UnpairedSection: View {
    let tab: AppNavigation.Tab
    @State private var pairing = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Cockpit.Space.s6) {
                    Card {
                        Text("Your life shows here once this iPhone is paired with Lifestream.")
                            .cockpit(.headline)
                            .foregroundStyle(Cockpit.Color.text)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Pair with Lifestream") { pairing = true }
                            .buttonStyle(.cockpit(.primary))
                            .accessibilityIdentifier("life.pair")
                    }
                }
                .padding(.horizontal, Cockpit.Gap.edge)
                .padding(.top, Cockpit.Gap.edge)
                .padding(.bottom, Cockpit.Space.s4)
            }
            .tabRoot(tab.title, captures: tab == .days)
            .groundColor(Cockpit.Color.canvas)
            .sheet(isPresented: $pairing) { PairingView() }
        }
    }
}

struct HomeStrip: View {
    @ObservedObject private var reach = AppRuntime.shared.reach
    @ObservedObject private var life = AppRuntime.shared.life
    @ObservedObject private var needs = PhoneNeeds.shared
    @ObservedObject private var home = AppRuntime.shared.homeStreams
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pairing = false
    @State private var all = false
    @State private var redrawn = 0

    private enum Banner: Identifiable {
        case reach(ReachWords.Strip)
        case need(HomeLink.Need)

        var id: String {
            switch self {
            case .reach: "reach"
            case .need(let need): need.id
            }
        }
    }

    var body: some View {
        let snapshot = reach.snapshot
        let strip = ReachWords.strip(snapshot, device: .phone, clock: HomeClock.current.clock, now: AppClock.now)
        let banners = Self.ordered(strip, needs.banner)
        let back = banners.isEmpty ? self.back(snapshot) : nil
        VStack(spacing: 0) {
            Group {
                if banners.count > 1, all {
                    VStack(spacing: Cockpit.Space.s2) {
                        ForEach(banners) { banner in drawn(banner, snapshot, others: nil) }
                    }
                } else if let first = banners.first {
                    drawn(first, snapshot, others: banners.count > 1 ? StatusStrip.Others(banners.count - 1) { all = true } : nil)
                } else if let back {
                    StatusStrip(.done, title: back.title, line: back.line, identifier: "home.back")
                }
            }
            .padding(.horizontal, Cockpit.Gap.edge)
            .padding(.vertical, Cockpit.Space.s2)
            .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
        }
        .frame(maxWidth: .infinity)
        .clipped()
        .animation(reduceMotion ? .easeInOut(duration: Cockpit.Duration.fast) : Cockpit.Ease.out(Cockpit.Duration.base),
                   value: banners.map(\.id) + (back == nil ? [] : ["back"]))
        .onChange(of: banners.count) { _, count in if count < 2 { all = false } }
        .task(id: snapshot.episode?.ended) {
            guard let ended = snapshot.episode?.ended, ReachWords.reached(snapshot, clock: HomeClock.current.clock, now: AppClock.now) != nil
            else { return }
            try? await Task.sleep(for: .seconds(max(0, ended.addingTimeInterval(ReachWords.reachedFor).timeIntervalSince(AppClock.now))))
            guard !Task.isCancelled else { return }
            reach.redraw()
        }
        .task(id: needs.back) {
            guard let at = needs.back else { return }
            try? await Task.sleep(for: .seconds(max(0, at.addingTimeInterval(ReachWords.reachedFor).timeIntervalSince(AppClock.now))))
            guard !Task.isCancelled else { return }
            redrawn += 1
        }
        .sheet(isPresented: $pairing) { PairingView() }
    }

    private static func ordered(_ strip: ReachWords.Strip?, _ needs: [HomeLink.Need]) -> [Banner] {
        let reach = strip.map { [Banner.reach($0)] } ?? []
        let held = needs.map(Banner.need)
        return strip?.tone == .warning ? reach + held : held + reach
    }

    private func back(_ snapshot: HomeLink.ReachSnapshot) -> (title: String, line: String?)? {
        let now = AppClock.now
        if let reached = ReachWords.reached(snapshot, clock: HomeClock.current.clock, now: now) { return (reached.title, reached.line) }
        _ = redrawn
        guard let at = needs.back, now.timeIntervalSince(at) < ReachWords.reachedFor else { return nil }
        let free = home.read.map { ByteCountFormatter.string(fromByteCount: $0.disk.freeBytes, countStyle: .file) + " free" }
        return (ReachWords.back.title, free)
    }

    @ViewBuilder private func drawn(_ banner: Banner, _ snapshot: HomeLink.ReachSnapshot, others: StatusStrip.Others?) -> some View {
        switch banner {
        case .reach(let strip): reached(strip, snapshot, others: others)
        case .need(let need):
            StatusStrip(.stopped, title: need.words, line: need.line,
                        since: need.sinceMs.map { ReachWords.since(Date(timeIntervalSince1970: Double($0) / 1000), clock: HomeClock.current.clock,
                                                                   now: AppClock.now) },
                        others: others, identifier: "home.need.\(need.id)")
        }
    }

    private func reached(_ strip: ReachWords.Strip, _ snapshot: HomeLink.ReachSnapshot, others: StatusStrip.Others?) -> some View {
        var line = strip.line
        if case .held(let hold) = snapshot.reach, let refused = life.checkRefused, refused.hold == hold { line = refused.words }
        let act: StatusStrip.Act? = strip.act.flatMap { act in
            switch act.do {
            case HomeLink.Act.Do.verify.rawValue:
                StatusStrip.Act(act.label, busy: life.checking) { Task { await life.checkAgain() } }
            case HomeLink.Act.Do.pair.rawValue:
                StatusStrip.Act(act.label) { pairing = true }
            case ReachWords.Act.tryAgain.do:
                StatusStrip.Act(act.label, busy: snapshot.checking) { Task { await AppRuntime.shared.shipping.link.checkAgain() } }
            default:
                nil
            }
        }
        let details: (() -> Void)? = snapshot.reach.isUnreachable ? { AppNavigation.shared.present(.reach) } : nil
        let severity: Cockpit.Severity = switch strip.tone {
        case .warning: .stopped
        case .caution: .needs
        case .waiting: .waiting
        }
        return StatusStrip(severity, title: strip.title, line: line, since: strip.meta,
                           act: act, details: details, others: others, identifier: "home.strip")
    }
}

extension View {
    func reachHead() -> some View {
        modifier(ReachHead())
    }
}

private struct ReachHead: ViewModifier {
    @ObservedObject private var reach = AppRuntime.shared.reach

    func body(content: Content) -> some View {
        VStack(spacing: 0) {
            HomeStrip()
            content.frame(maxHeight: .infinity)
        }
        .environment(\.reachLacks, reach.lacks)
    }
}

extension InPlaceLine.Said {
    init(_ said: HomeLink.ActSaid) {
        switch said {
        case .notSent: self = .notSent
        case .refused(let words): self = .refused(words)
        case .saving: self = .saving(ReachWords.saving)
        case .unknown(let words): self = .unknown(words)
        }
    }
}

extension HomeLink.ActSaid {
    init(_ error: Error) {
        switch error as? LifeReader.Failure {
        case .reach?, .unpaired?, .failed?: self = .notSent
        case .busy(let words, _, _, _)?, .refused(let words)?: self = .refused(words)
        case .unknown(let words)?: self = .unknown(words)
        case .missing?: self = .refused(ReachWords.refused)
        case nil: self = HomeLink.state(of: error, now: AppClock.now).flatMap(ReachWords.act) ?? .notSent
        }
    }

    var sendsAgain: Bool {
        self == .notSent || self == .saving
    }
}

extension View {
    func readsAgain(failed: @escaping @MainActor () -> LifeReader.Failure?, _ read: @escaping @MainActor () async -> Void) -> some View {
        readsAgain(failures: { [failed()] }, read)
    }

    func readsAgain(failures: @escaping @MainActor () -> [LifeReader.Failure?], _ read: @escaping @MainActor () async -> Void) -> some View {
        modifier(ReadsAgain(failed: {
            let failures = failures().compactMap { $0 }
            return (failures.compactMap(\.since).min(), failures.compactMap(\.until).min())
        }, read: read))
    }

    func readsAgain(begun: @escaping @MainActor () -> Int?, _ read: @escaping @MainActor () async -> Void) -> some View {
        modifier(ReadsAgain(failed: { (begun(), nil) }, read: read))
    }

    func readsAgain(unread: @escaping @MainActor () -> Bool, _ read: @escaping @MainActor () async -> Void) -> some View {
        modifier(ReadsAgainUnread(unread: unread, read: read))
    }
}

private struct ReadsAgainUnread: ViewModifier {
    let unread: @MainActor () -> Bool
    let read: @MainActor () async -> Void
    @ObservedObject private var reach = AppRuntime.shared.reach
    @State private var since: Int?

    func body(content: Content) -> some View {
        let unread = unread()
        content
            .readsAgain(begun: { since }, read)
            .onChange(of: unread, initial: true) { _, unread in since = unread ? since ?? reach.snapshot.revision : nil }
    }
}

struct ReadAgain: Equatable {
    let revision: Int
    let begun: Int?
    var until: Date? = nil

    var due: Bool { begun.map { $0 < revision } ?? false }

    func wait(now: Date) -> TimeInterval? {
        if due { return 0 }
        return until.map { max(0, $0.timeIntervalSince(now)) }
    }
}

private struct ReadsAgain: ViewModifier {
    let failed: @MainActor () -> (begun: Int?, until: Date?)
    let read: @MainActor () async -> Void
    @ObservedObject private var reach = AppRuntime.shared.reach

    func body(content: Content) -> some View {
        let failed = failed()
        let again = ReadAgain(revision: reach.snapshot.revision, begun: failed.begun, until: failed.until)
        content
            .task(id: again) {
                guard let wait = again.wait(now: AppClock.now) else { return }
                if wait > 0 {
                    try? await Task.sleep(for: .seconds(wait))
                    guard !Task.isCancelled else { return }
                }
                await read()
            }
    }
}

struct ReadLack: View {
    let failure: LifeReader.Failure
    let lacks: String
    let words: String?
    let lacking: String
    let retry: (() -> Void)?
    @ObservedObject private var reach = AppRuntime.shared.reach

    enum Shown: Equatable {
        case waits, lacks, says

        init(_ failure: LifeReader.Failure, lacking: Bool) {
            switch failure {
            case .reach, .busy: self = lacking ? .lacks : .waits
            default: self = .says
            }
        }
    }

    init(_ failure: LifeReader.Failure, lacks: String, words: String?, lacking: String = "life.lacks", retry: (() -> Void)? = nil) {
        self.failure = failure
        self.lacks = lacks
        self.words = words
        self.lacking = lacking
        self.retry = retry
    }

    var body: some View {
        switch Shown(failure, lacking: reach.lacks) {
        case .waits:
            WaitLine(words: waits)
                .waiting(true)
        case .lacks:
            PageLack(lacks)
                .accessibilityIdentifier(lacking)
        case .says:
            if let words {
                PageLack(words, retry: retry)
                    .accessibilityIdentifier("life.failed")
            }
        }
    }

    private var waits: String? {
        if case .busy(let words, _, _, _) = failure { words } else { nil }
    }
}
