import Combine
import Foundation

@MainActor final class RecordingGate {
    private(set) var open = false
    private let world: @Sendable () -> SetupWorld
    private let paused: () -> Bool
    private let start: () -> Void
    private var phase: AnyCancellable?

    init(world: @escaping @Sendable () -> SetupWorld, paused: @escaping () -> Bool,
         start: @escaping () -> Void) {
        self.world = world
        self.paused = paused
        self.start = start
    }

    func check() async {
        guard !open else { return }
        let world = self.world
        await opens(Task.detached { world() }.value)
    }

    func opens(_ world: SetupWorld) {
        guard !open, world.setUp else { return }
        open = true
        guard !paused() else { return }
        start()
    }

    func watch(_ setup: SetupStart) {
        phase = setup.$phase.sink { [weak self] phase in
            guard phase == .done else { return }
            Task { @MainActor in await self?.check() }
        }
    }
}
