import Combine
import HomeLink
import LifestreamCaptureCore

@MainActor
final class HomeToday: ObservableObject {
    static let shared = HomeToday()

    @Published private(set) var today = HomeClock.current.today()
    @Published private(set) var clock = HomeClock.current.clock
    @Published private(set) var revision = HomeClock.current.revision

    private init() {
        HomeClock.current.onChange { Task { @MainActor in HomeToday.shared.changed() } }
    }

    private func changed() {
        let now = HomeClock.current.snapshot
        let today = HomeClock.current.telling(by: now) { HomeClock.current.today() }
        if today != self.today { self.today = today }
        if now.clock != clock { clock = now.clock }
        if now.revision != revision { revision = now.revision }
    }
}
