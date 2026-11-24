import Observation
import SwiftUI

public struct SheetEdit {
    public enum Kept: Sendable, Equatable {
        case close, stay
    }

    public struct Failed: Error, Equatable {
        public let said: InPlaceLine.Said

        public init(_ said: InPlaceLine.Said) { self.said = said }
    }

    let differs: Bool?
    let ready: Bool
    let keepLabel: String
    let keepIcon: Cockpit.Icon
    let identifier: String?
    let acts: SheetActs?
    let cancel: (() -> Void)?
    let keep: @MainActor () async throws -> Kept

    public init<Value: Equatable>(opened: Value, now: Value, ready: Bool = true, keepLabel: String = "Save",
                                  identifier: String? = nil, acts: SheetActs? = nil, cancel: (() -> Void)? = nil,
                                  keep: @escaping @MainActor () async throws -> Kept) {
        self.init(differs: opened != now, ready: ready, keepLabel: keepLabel, identifier: identifier, acts: acts,
                  cancel: cancel, keep: keep)
    }

    public init(ready: Bool = true, keepLabel: String = "Save", keepIcon: Cockpit.Icon = .done, identifier: String? = nil,
                acts: SheetActs? = nil, cancel: (() -> Void)? = nil, keep: @escaping @MainActor () async throws -> Kept) {
        self.init(differs: nil, ready: ready, keepLabel: keepLabel, keepIcon: keepIcon, identifier: identifier, acts: acts, cancel: cancel,
                  keep: keep)
    }

    private init(differs: Bool?, ready: Bool, keepLabel: String, keepIcon: Cockpit.Icon = .done, identifier: String?, acts: SheetActs?,
                 cancel: (() -> Void)?, keep: @escaping @MainActor () async throws -> Kept) {
        self.differs = differs
        self.ready = ready
        self.keepLabel = keepLabel
        self.keepIcon = keepIcon
        self.identifier = identifier
        self.acts = acts
        self.cancel = cancel
        self.keep = keep
    }

    func named(_ part: String) -> String { identifier.map { "\($0).\(part)" } ?? "drawer.\(part)" }
}

@MainActor @Observable
public final class SheetActs {
    public static let keep = "keep"

    public private(set) var outcome: ActOutcome
    public private(set) var act: String?
    public private(set) var closed = false
    @ObservationIgnored private var last: (@MainActor () async throws -> SheetEdit.Kept)?

    public init() { outcome = .idle }

    init(drawn outcome: ActOutcome) {
        self.outcome = outcome
        act = Self.keep
    }

    public var running: Bool { outcome.running }

    public func running(_ act: String) -> Bool { running && self.act == act }

    public var canCancel: Bool { !running && !closed }

    public func canKeep(_ edit: SheetEdit) -> Bool { edit.differs != false && edit.ready && !running && !closed }

    public func holds(_ edit: SheetEdit) -> Bool { running || edit.differs == true }

    @discardableResult
    public func run(_ act: String = SheetActs.keep, _ work: @escaping @MainActor () async throws -> SheetEdit.Kept) async -> Bool {
        guard !running, !closed else { return false }
        self.act = act
        last = work
        outcome = .running
        do {
            let kept = try await work()
            outcome = .idle
            last = nil
            if kept == .close { closed = true }
            return true
        } catch {
            outcome = .failed((error as? SheetEdit.Failed)?.said ?? .refused(error.localizedDescription))
            return false
        }
    }

    public func forget() {
        last = nil
    }

    public func again() {
        guard let last, let act else { return }
        Task { await run(act, last) }
    }
}

extension InPlaceLine.Said {
    var words: String {
        switch self {
        case .notSent: "Not sent"
        case .refused(let words), .saving(let words), .unknown(let words): words
        }
    }
}

struct SheetCancel: View {
    let edit: SheetEdit
    let acts: SheetActs
    let action: () -> Void

    var body: some View {
        DrawerCircle(.close, label: "Cancel", action: action)
            .disabled(!acts.canCancel)
            .accessibilityIdentifier(edit.named("cancel"))
    }
}

struct SheetKeep: View {
    let edit: SheetEdit
    let acts: SheetActs

    var body: some View {
        let keeping = acts.running(SheetActs.keep)
        DrawerCircle(edit.keepIcon, label: keeping ? "Saving" : edit.keepLabel, filled: true, busy: keeping) {
            let keep = edit.keep
            Task { await acts.run(SheetActs.keep, keep) }
        }
        .disabled(!acts.canKeep(edit))
        .accessibilityIdentifier(edit.named("save"))
    }
}

struct SheetFailure: View {
    let edit: SheetEdit
    let acts: SheetActs

    var body: some View {
        if let failure = acts.outcome.failure {
            InPlaceLine(failure, retry: acts.again)
                .accessibilityIdentifier(edit.named("error"))
        }
    }
}

struct SheetEditing: ViewModifier {
    let edit: SheetEdit
    let acts: SheetActs
    @Environment(\.dismiss) private var dismiss

    func body(content: Content) -> some View {
        content
            .interactiveDismissDisabled(acts.holds(edit))
            .onChange(of: acts.closed) { _, closed in if closed { dismiss() } }
            .onDisappear { acts.forget() }
            .onChange(of: acts.outcome) { _, outcome in
                if let failure = outcome.failure { AccessibilityNotification.Announcement(failure.words).post() }
            }
    }
}

#if os(iOS)
public extension View {
    func sheetEditBar(_ edit: SheetEdit) -> some View { modifier(SheetEditBar(edit: edit)) }
}

private struct SheetEditBar: ViewModifier {
    let edit: SheetEdit
    @State private var own = SheetActs()
    @Environment(\.dismiss) private var dismiss

    private var acts: SheetActs { edit.acts ?? own }

    func body(content: Content) -> some View {
        content
            .disabled(acts.running)
            .safeAreaInset(edge: .top, spacing: 0) {
                if acts.outcome.failure != nil {
                    SheetFailure(edit: edit, acts: acts)
                        .padding(.horizontal, Cockpit.Space.s4)
                        .padding(.vertical, Cockpit.Space.s2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .groundColor(Cockpit.Color.surface)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    SheetCancel(edit: edit, acts: acts) { if let cancel = edit.cancel { cancel() } else { dismiss() } }
                        .padding(.leading, Cockpit.Gap.sheet - Cockpit.sheetBarInset)
                }
                .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .confirmationAction) {
                    SheetKeep(edit: edit, acts: acts)
                        .padding(.trailing, Cockpit.Gap.sheet - Cockpit.sheetBarInset)
                }
                .sharedBackgroundVisibility(.hidden)
            }
            .modifier(SheetEditing(edit: edit, acts: acts))
    }
}
#endif
