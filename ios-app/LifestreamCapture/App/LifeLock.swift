import Combine
import Foundation
import LocalAuthentication
import UIKit

@MainActor
final class LifeLock: ObservableObject {
    static let shared = LifeLock()

    @Published private(set) var isLocked: Bool { didSet { faced() } }
    @Published private(set) var face = LockFace.open
    @Published private(set) var proofs: [String] = []
    private let mode: Mode
    private var mayAsk = true { didSet { faced() } }
    private var asking = false { didSet { faced() } }
    private let passes = Passes { UIApplication.shared.applicationState }
    private var context: LAContext?

    private enum Mode: Equatable { case device, uiTestOpen, uiTestLocked(declinesOnce: Bool) }

    private init() {
        let arguments = ProcessInfo.processInfo.arguments
        if !AppRuntime.isUITesting {
            mode = .device
        } else if arguments.contains("--ui-test-locked") {
            mode = .uiTestLocked(declinesOnce: arguments.contains("--ui-test-face-id-declines-once"))
        } else {
            mode = .uiTestOpen
        }
        switch mode {
        case .device: isLocked = Self.passcodeSet()
        case .uiTestOpen: isLocked = false
        case .uiTestLocked: isLocked = true
        }
        faced()
        for name in [UIApplication.didBecomeActiveNotification, UIApplication.didEnterBackgroundNotification] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { LifeLock.shared.passes.changed() }
            }
        }
    }

    private func faced() {
        let face = LockFace(locked: isLocked, asking: asking, due: mode == .device && mayAsk)
        if face != self.face { self.face = face }
    }

    var turn: Int { passes.turn }

    func lock() {
        mayAsk = true
        passes.lock()
        context?.invalidate()
        context = nil
        switch mode {
        case .device: isLocked = Self.passcodeSet()
        case .uiTestLocked: isLocked = true
        case .uiTestOpen: break
        }
    }

    func arrived() {
        mayAsk = true
    }

    func askIfDue() async {
        guard mode == .device, isLocked, mayAsk else { return }
        mayAsk = false
        await unlock()
    }

    func unlock() async {
        guard isLocked, !asking else { return }
        guard mode == .device else {
            isLocked = false
            return
        }
        guard Self.passcodeSet() else {
            isLocked = false
            return
        }
        asking = true
        defer { asking = false }
        if await ask("Open your days, people and places.") { isLocked = false }
    }

    func prove(_ reason: String = "Let an agent read your Lifestream.") async -> Bool {
        switch mode {
        case .uiTestOpen:
            return true
        case .uiTestLocked(let declinesOnce):
            let passed = !(declinesOnce && proofs.isEmpty)
            proofs.append(passed ? "passed" : "declined")
            if passed { isLocked = false }
            return passed
        case .device:
            guard Self.passcodeSet() else { return true }
            guard !asking else { return false }
            asking = true
            defer { asking = false }
            guard await ask(reason) else { return false }
            isLocked = false
            return true
        }
    }

    private static func passcodeSet() -> Bool {
        var error: NSError?
        if LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) { return true }
        return error?.code != LAError.passcodeNotSet.rawValue
    }

    private func ask(_ reason: String) async -> Bool {
        let asked = passes.turn
        let context = LAContext()
        self.context = context
        let passed = await Self.evaluate(Asking(context: context), reason)
        if self.context === context { self.context = nil }
        guard passed else { return false }
        return await passes.settle(asked)
    }

    nonisolated private static func evaluate(_ asking: Asking, _ reason: String) async -> Bool {
        (try? await asking.context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }

    private struct Asking: @unchecked Sendable {
        let context: LAContext
    }
}

enum LockFace: Equatable {
    case open, waits, offers

    init(locked: Bool, asking: Bool, due: Bool) {
        if !locked { self = .open } else if asking || due { self = .waits } else { self = .offers }
    }
}

struct LockTurns: Equatable {
    private(set) var generation = 0

    mutating func lock() { generation += 1 }

    enum Verdict: Equatable { case open, wait, shut }

    func judge(_ asked: Int, _ state: UIApplication.State) -> Verdict {
        guard asked == generation else { return .shut }
        switch state {
        case .active: return .open
        case .inactive: return .wait
        default: return .shut
        }
    }
}

@MainActor
final class Passes {
    private var turns = LockTurns()
    private let state: @MainActor () -> UIApplication.State
    private var waiting: [CheckedContinuation<Void, Never>] = []

    init(state: @escaping @MainActor () -> UIApplication.State) {
        self.state = state
    }

    var turn: Int { turns.generation }
    var held: Int { waiting.count }

    func lock() {
        turns.lock()
        changed()
    }

    func changed() {
        let woken = waiting
        waiting = []
        for pass in woken { pass.resume() }
    }

    func settle(_ asked: Int) async -> Bool {
        while true {
            switch turns.judge(asked, state()) {
            case .open: return true
            case .shut: return false
            case .wait: await withCheckedContinuation { waiting.append($0) }
            }
        }
    }
}
