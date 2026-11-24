import Evidence
import Foundation

public final class DeviceUseWatch: @unchecked Sendable {
    private let queue = DispatchQueue(label: "org.lifestreamprotocol.device-use.watch")
    private let monitor: DeviceUseMonitor
    private let modes: RecordingModes
    private var read: DeviceUse?
    private var shown: DeviceUse?

    public init(modes: RecordingModes, probe: any DeviceUseProbe = SystemDeviceUseProbe()) {
        self.modes = modes
        monitor = DeviceUseMonitor(probe: probe, queue: queue)
    }

    public func start(_ emit: @escaping (DeviceUse, [String]) -> Void) {
        queue.sync {
            let first = monitor.start { [weak self] next in self?.changed(next, emit) }
            read = first
            shown = DeviceUseEvents.visible(first, under: modes)
            let state = MachineEvent(at: first.at, name: .state, detail: DeviceUseEvents.stateDetail(shown))
            emit(first, [try? MachineEventCodec.line(state)].compactMap { $0 })
        }
    }

    public func stop() {
        queue.sync { monitor.stop() }
    }

    private func changed(_ next: DeviceUse, _ emit: (DeviceUse, [String]) -> Void) {
        let merged = DeviceUseEvents.merged(next, over: read)
        read = merged
        let visible = DeviceUseEvents.visible(merged, under: modes)
        let lines = DeviceUseEvents.events(from: shown, to: visible).compactMap { try? MachineEventCodec.line($0) }
        shown = visible
        emit(merged, lines)
    }
}
