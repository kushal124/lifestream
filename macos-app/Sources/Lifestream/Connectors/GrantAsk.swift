import AppKit

@MainActor final class GrantAsk {
    struct System {
        var held: @Sendable (Grant) -> Bool
        var unanswered: @Sendable (Grant) -> Bool
        var question: @MainActor (Grant) async -> Void
        var pane: @MainActor (Grant) async -> Void
        var settingsOpen: @MainActor () -> Bool
        var away: @MainActor () -> Bool
        var every: Duration = .seconds(1)
        var opening: Duration = .seconds(5)
        var alerts: @Sendable (Grant) -> Bool = { _ in false }
        var alert: @MainActor (Grant) async -> Void = { _ in }
        var putAway: @MainActor () async -> Void = {}

        static let live = System(held: { $0.granted }, unanswered: { $0.unanswered },
                                 question: { grant in
                                     NSApp.activate(ignoringOtherApps: true)
                                     await grant.question()
                                 },
                                 pane: { grant in
                                     await grant.list()
                                     await SystemSettings.open(grant.pane)
                                 },
                                 settingsOpen: { !NSRunningApplication.runningApplications(withBundleIdentifier: SystemSettings.id).isEmpty },
                                 away: { !NSApp.isActive },
                                 alerts: { $0.alerts },
                                 alert: { grant in
                                     for running in NSRunningApplication.runningApplications(withBundleIdentifier: SystemSettings.id) {
                                         await SystemSettings.quit(running)
                                     }
                                     await grant.alert()
                                 },
                                 putAway: { await SystemSettings.putAway() })
    }

    private(set) var asking: [Grant] = []
    private(set) var denied: Set<Grant> = []
    var changed: () -> Void = {}
    var guiding: (Grant?) -> Void = { _ in }
    var reread: () async -> Void = {}

    private let system: System
    private var left: Bool?
    private var back = false
    private var step = 0
    private var running: Task<Void, Never>?

    init(system: System) {
        self.system = system
    }

    func ask(_ grants: [Grant]) {
        finish(step)
        guiding(nil)
        step += 1
        let mine = step
        asking = grants
        denied.subtract(grants)
        changed()
        let system = system
        running = Task { [weak self] in
            await system.putAway()
            for grant in grants {
                guard let self, mine == self.step else { return }
                let held = await self.one(grant, mine: mine, system: system)
                guard mine == self.step else { return }
                if held, !grant.reopens { await system.putAway() }
                guard mine == self.step else { return }
                await self.reread()
                guard mine == self.step else { return }
                self.asking.removeAll { $0 == grant }
                if !held {
                    self.denied.insert(grant)
                    self.asking = []
                }
                self.left = nil
                self.back = false
                self.changed()
                guard held else { break }
            }
            self?.finish(mine)
        }
    }

    private func one(_ grant: Grant, mine: Int, system: System) async -> Bool {
        let held = { await Task.detached(operation: { system.held(grant) }).value }
        if await held() { return true }
        if grant.questioned, await Task.detached(operation: { system.unanswered(grant) }).value {
            await system.question(grant)
            return await held()
        }
        if await Task.detached(operation: { system.alerts(grant) }).value {
            left = false
            back = false
            await system.alert(grant)
            while true {
                try? await Task.sleep(for: system.every)
                guard mine == step, !Task.isCancelled else { return false }
                if await held() { return true }
                if system.settingsOpen() { break }
                if back { return false }
            }
        } else {
            await system.pane(grant)
            guard mine == step else { return false }
        }
        guiding(grant)
        defer { if mine == step { guiding(nil) } }
        left = system.away()
        back = false
        let opened = ContinuousClock.now
        var seen = false
        while mine == step, !Task.isCancelled {
            try? await Task.sleep(for: system.every)
            if await held() { return true }
            guard mine == step else { return false }
            if back { return false }
            if system.settingsOpen() {
                seen = true
            } else if seen || ContinuousClock.now - opened > system.opening {
                return false
            }
        }
        return false
    }

    func resigned() {
        if left != nil { left = true }
    }

    func cameBack() {
        if left == true { back = true }
    }

    func end() {
        finish(step)
    }

    private func finish(_ mine: Int) {
        guard mine == step, !asking.isEmpty else { return }
        step += 1
        running?.cancel()
        running = nil
        asking = []
        left = nil
        back = false
        guiding(nil)
        changed()
    }
}
