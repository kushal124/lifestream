import CoreAudio
import CoreMediaIO
import XCTest
import Evidence
@testable import MachineEvents

final class DeviceUseTests: XCTestCase {
    private let t0 = UTCInstant.date(rfc3339: "2026-09-30T10:00:00.000Z")!
    private let microphone = AudioDeviceFacts(uid: "synthetic-input-uid", name: "Synthetic Microphone", transport: "built_in")
    private let headset = AudioDeviceFacts(uid: "synthetic-headset-uid", name: "Synthetic Headset", transport: "bluetooth")
    private let speakers = AudioDeviceFacts(uid: "synthetic-output-uid", name: "Synthetic Speakers", transport: "built_in")
    private let camera = CameraFacts(uid: "synthetic-camera-uid", name: "Synthetic Camera")

    private func client(_ app: String, _ device: AudioDeviceFacts?, pid: Int32 = 501, raw: String? = nil) -> AudioClient {
        AudioClient(pid: pid, app: app, rawApp: raw ?? app, device: device)
    }

    private func use(_ seconds: Double, microphone: [AudioClient] = [], sound: [AudioClient] = [],
                     output: DeviceLevel? = nil, inputVolume: Double = 0.75, cameras: [CameraFacts]? = []) -> DeviceUse {
        DeviceUse(at: t0.addingTimeInterval(seconds),
                  audio: AudioUse(microphone: microphone, sound: sound,
                                  output: output ?? DeviceLevel(device: speakers, volume: 0.5, muted: false),
                                  input: DeviceLevel(device: self.microphone, volume: inputVolume, muted: false),
                                  defaultInputRunning: !microphone.isEmpty),
                  cameras: cameras)
    }

    private func names(_ events: [MachineEvent]) -> [String] { events.map(\.name.rawValue) }

    func testClientsThatComeAndGoWriteStartsAndStops() {
        let chrome = client("com.google.Chrome", microphone, pid: 4242, raw: "com.google.Chrome.helper")
        let player = client("com.example.player", speakers, pid: 600)
        let started = DeviceUseEvents.events(from: use(0), to: use(1, microphone: [chrome], sound: [player]))
        XCTAssertEqual(names(started), ["mic_start", "sound_start"])
        XCTAssertEqual(started[0].at, t0.addingTimeInterval(1))
        XCTAssertEqual(started[0].detail, [
            "app": .text("com.google.Chrome"), "raw_app": .text("com.google.Chrome.helper"), "pid": .number(4242),
            "device": .text("synthetic-input-uid"), "device_name": .text("Synthetic Microphone"), "transport": .text("built_in"),
        ])
        XCTAssertNil(started[1].detail["raw_app"], "raw_app is stated only when it differs")
        let stopped = DeviceUseEvents.events(from: use(1, microphone: [chrome], sound: [player]), to: use(2))
        XCTAssertEqual(names(stopped), ["mic_stop", "sound_stop"])
        XCTAssertEqual(DeviceUseEvents.events(from: nil, to: use(1, microphone: [chrome])), [],
                       "the first read is the state line's, not a start")
    }

    func testAProcessThatMovesDeviceStopsThenStarts() {
        let before = use(0, microphone: [client("us.zoom.xos", microphone)])
        let after = use(1, microphone: [client("us.zoom.xos", headset)])
        let events = DeviceUseEvents.events(from: before, to: after)
        XCTAssertEqual(names(events), ["mic_stop", "mic_start"])
        XCTAssertEqual(events[0].detail["device"], .text("synthetic-input-uid"))
        XCTAssertEqual(events[1].detail["device"], .text("synthetic-headset-uid"))
        let unknown = DeviceUseEvents.events(from: use(1), to: use(2, microphone: [client("us.zoom.xos", nil)]))
        XCTAssertEqual(unknown.first?.detail["device_unavailable"], .flag(true))
    }

    func testAnExcludedAppLeavesNoLine() {
        let modes = RecordingModes(activity: ["com.example.chat"], exclude: ["com.example.vault"])
        let read = use(1, microphone: [client("com.example.vault", microphone), client("com.example.chat", microphone, pid: 7)],
                       sound: [client("com.example.player", speakers, raw: "com.example.vault")])
        let shown = DeviceUseEvents.visible(read, under: modes)
        XCTAssertEqual(shown.audio?.microphone.map(\.app), ["com.example.chat"], "activity mode is used and named")
        XCTAssertEqual(shown.audio?.sound, [], "a helper of an excluded app is excluded by its own id too")
        XCTAssertEqual(names(DeviceUseEvents.events(from: DeviceUseEvents.visible(use(0), under: modes), to: shown)),
                       ["mic_start"])
    }

    func testCamerasStateNoProcess() {
        let events = DeviceUseEvents.events(from: use(0), to: use(1, cameras: [camera]))
        XCTAssertEqual(names(events), ["camera_start"])
        XCTAssertEqual(events[0].detail, ["device": .text("synthetic-camera-uid"), "device_name": .text("Synthetic Camera"),
                                          "app_unavailable": .flag(true)])
        XCTAssertEqual(names(DeviceUseEvents.events(from: use(1, cameras: [camera]), to: use(2))), ["camera_stop"])
    }

    func testTheOutputDeviceAndItsLevel() {
        let moved = DeviceUseEvents.events(from: use(0), to: use(1, output: DeviceLevel(device: headset, volume: 0.3, muted: nil)))
        XCTAssertEqual(names(moved), ["output_device"])
        XCTAssertEqual(moved[0].detail, ["device": .text("synthetic-headset-uid"), "device_name": .text("Synthetic Headset"),
                                         "transport": .text("bluetooth"), "volume": .number(0.3), "mute_unavailable": .flag(true)])
        let level = DeviceUseEvents.events(from: use(1), to: use(2, output: DeviceLevel(device: speakers, volume: 0.504, muted: true)))
        XCTAssertEqual(names(level), ["output_volume"])
        XCTAssertEqual(level[0].detail, ["device": .text("synthetic-output-uid"), "volume": .number(0.5), "muted": .flag(true)])
        XCTAssertEqual(DeviceUseEvents.events(from: use(1), to: use(2, output: DeviceLevel(device: speakers, volume: 0.501, muted: false))),
                       [], "a level that rounds to the same two places is no change")
        XCTAssertEqual(DeviceUseEvents.events(from: use(1), to: use(2, inputVolume: 0.24)), [],
                       "the microphone's gain is the recording's to state, not a device line")
    }

    func testAnUnreadableReadWritesNoStop() {
        let running = use(0, microphone: [client("us.zoom.xos", microphone)], cameras: [camera])
        let failed = DeviceUse(at: t0.addingTimeInterval(1), audio: nil, cameras: nil)
        let merged = DeviceUseEvents.merged(failed, over: running)
        XCTAssertEqual(DeviceUseEvents.events(from: running, to: merged), [])
        XCTAssertEqual(merged.audio, running.audio)
        XCTAssertEqual(merged.cameras, running.cameras)
    }

    func testTheStateLineStatesTheDevices() {
        let read = use(0, microphone: [client("us.zoom.xos", microphone), client("com.google.Chrome", microphone, pid: 9)],
                       sound: [client("us.zoom.xos", speakers)], output: DeviceLevel(device: speakers, volume: nil, muted: false))
        XCTAssertEqual(DeviceUseEvents.stateDetail(read), [
            "mic_in_use": .flag(true), "mic_apps": .text("com.google.Chrome,us.zoom.xos"),
            "sound_in_use": .flag(true), "sound_apps": .text("us.zoom.xos"),
            "output_device": .text("synthetic-output-uid"), "output_device_name": .text("Synthetic Speakers"),
            "output_transport": .text("built_in"), "output_volume_unavailable": .flag(true), "output_muted": .flag(false),
            "camera_in_use": .flag(false),
        ])
        XCTAssertEqual(DeviceUseEvents.stateDetail(nil), ["audio_unavailable": .flag(true), "camera_unavailable": .flag(true)])
        let state = MachineState(devices: read)
        XCTAssertEqual(state.detail["mic_apps"], .text("com.google.Chrome,us.zoom.xos"), "the state line carries them")
    }

    func testADeviceLineIsPinnedBytes() throws {
        let event = MachineEvent(at: t0, name: .micStart,
                                 detail: DeviceUseEvents.clientDetail(client("com.google.Chrome", microphone, pid: 4242,
                                                                             raw: "com.google.Chrome.helper")))
        XCTAssertEqual(try MachineEventCodec.line(event),
                       "{\"at\":\"2026-09-30T10:00:00.000Z\",\"event\":\"mic_start\",\"detail\":{\"app\":\"com.google.Chrome\","
                       + "\"device\":\"synthetic-input-uid\",\"device_name\":\"Synthetic Microphone\",\"pid\":4242,"
                       + "\"raw_app\":\"com.google.Chrome.helper\",\"transport\":\"built_in\"}}")
        XCTAssertEqual(try MachineEventCodec.event(try MachineEventCodec.line(event)), event)
    }

    func testTheMonitorCoalescesSignalsAndDropsReadsThatDidNotChange() throws {
        let probe = ScriptedProbe(reads: [use(0), use(1, microphone: [client("us.zoom.xos", microphone)])])
        let queue = DispatchQueue(label: "device-use-test")
        let monitor = DeviceUseMonitor(probe: probe, queue: queue, clock: { [t0] in t0.addingTimeInterval(7) })
        var delivered: [DeviceUse] = []
        let first = queue.sync { monitor.start { delivered.append($0) } }
        defer { queue.sync { monitor.stop() } }
        XCTAssertEqual(first.audio?.microphone, [])
        queue.suspend()
        for _ in 0..<20 { probe.signal(.clients) }
        queue.resume()
        try until("queue.sync { delivered.count } == 1") { queue.sync { delivered.count } == 1 }
        XCTAssertEqual(probe.readCount, 2, "twenty signals in one window are one read")
        XCTAssertEqual(delivered.count, 1)
        XCTAssertEqual(delivered.first?.at, t0.addingTimeInterval(7), "a read is stamped with its window's first signal")

        probe.signal(.level)
        try until("queue.sync { probe.readCount } == 3") { queue.sync { probe.readCount } == 3 }
        XCTAssertEqual(probe.readCount, 3)
        XCTAssertEqual(delivered.count, 1, "a read equal to the last one is not delivered")
        queue.sync { monitor.stop() }
        XCTAssertTrue(probe.stopped)
    }


    private func observed(_ fake: FakeDeviceSystem) -> SystemDeviceUseProbe {
        let probe = SystemDeviceUseProbe(system: fake, ownPID: 1, ownApp: "org.example.recorder")
        probe.observe { _ in }
        _ = probe.read(at: t0)
        return probe
    }

    private func microphoneApps(_ read: DeviceUse) -> [String] { read.audio?.microphone.map(\.app) ?? [] }
    private func soundApps(_ read: DeviceUse) -> [String] { read.audio?.sound.map(\.app) ?? [] }

    func testAReadRereadsOnlyTheProcessesWhoseListenerFired() {
        let fake = FakeDeviceSystem(processes: 4)
        let probe = observed(fake)
        XCTAssertEqual(fake.flagReads, [101: 1, 102: 1, 103: 1, 104: 1], "the first read reads every process")
        let laid = fake.listens

        fake.table[102]?.input = true
        fake.fire(102, kAudioProcessPropertyIsRunningInput)
        XCTAssertEqual(microphoneApps(probe.read(at: t0)), ["com.example.app-2"])
        XCTAssertEqual(fake.flagReads, [101: 1, 102: 2, 103: 1, 104: 1], "only the process whose listener fired")
        XCTAssertEqual(fake.listens, laid, "no listener is laid again while the objects stay the same")

        XCTAssertEqual(microphoneApps(probe.read(at: t0)), ["com.example.app-2"], "a trusted flag still states its client")
        XCTAssertEqual(fake.flagReads, [101: 1, 102: 2, 103: 1, 104: 1])
    }

    func testANewProcessIsListenedToBeforeItIsRead() {
        let monitored = FakeDeviceSystem(processes: 2)
        let queue = DispatchQueue(label: "device-use-test")
        let monitor = DeviceUseMonitor(probe: SystemDeviceUseProbe(system: monitored, ownPID: 1, ownApp: "org.example.recorder"),
                                       queue: queue)
        _ = queue.sync { monitor.start { _ in } }
        queue.sync { monitor.stop() }
        XCTAssertLessThan(monitored.calls.firstIndex(of: "listen 101")!, monitored.calls.firstIndex(of: "read 101")!,
                          "the monitor listens before its first read")

        let fake = FakeDeviceSystem(processes: 2)
        let probe = observed(fake)
        fake.add(105, input: true)
        fake.fire(UInt32(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList)
        XCTAssertEqual(microphoneApps(probe.read(at: t0)), ["com.example.app-5"], "a process that arrives running is read")
        XCTAssertLessThan(fake.calls.firstIndex(of: "listen 105")!, fake.calls.firstIndex(of: "read 105")!,
                          "its listeners are laid before its flags are read")

        fake.table[105]?.output = true
        fake.fire(105, kAudioProcessPropertyIsRunningOutput)
        XCTAssertEqual(soundApps(probe.read(at: t0)), ["com.example.app-5"])
    }

    func testAListenerThatFiresDuringAReadIsReadNext() {
        let fake = FakeDeviceSystem(processes: 3)
        let probe = observed(fake)
        fake.duringRead = { process in
            guard process == 101 else { return }
            fake.duringRead = nil
            fake.table[103]?.output = true
            fake.fire(103, kAudioProcessPropertyIsRunningOutput)
        }
        fake.fire(101, kAudioProcessPropertyIsRunningOutput)
        _ = probe.read(at: t0)
        XCTAssertEqual(soundApps(probe.read(at: t0)), ["com.example.app-3"])
    }

    func testAProcessWithARefusedListenerIsReadEveryTime() {
        let fake = FakeDeviceSystem(processes: 3)
        fake.refused = [102]
        let probe = observed(fake)
        fake.table[102]?.output = true
        XCTAssertEqual(soundApps(probe.read(at: t0)), ["com.example.app-2"], "no listener can vouch for it, so it is read")
        XCTAssertEqual(fake.flagReads[102], 2)
        XCTAssertEqual(fake.flagReads[101], 1)

        fake.refused = []
        let laid = fake.listens
        _ = probe.read(at: t0)
        XCTAssertGreaterThan(fake.listens, laid, "a refused listener is asked for again")
        XCTAssertEqual(fake.flagReads[102], 3)
        _ = probe.read(at: t0)
        XCTAssertEqual(fake.flagReads[102], 3, "once laid, its flags are trusted")
    }

    func testAFlagThatDidNotAnswerIsReadAgain() {
        let fake = FakeDeviceSystem(processes: 3)
        fake.unanswered = [102]
        let probe = observed(fake)
        fake.unanswered = []
        fake.table[102]?.output = true
        XCTAssertEqual(soundApps(probe.read(at: t0)), ["com.example.app-2"])
    }

    func testAnUnexplainedDefaultInputReadsEveryProcess() {
        let fake = FakeDeviceSystem(processes: 4)
        let probe = observed(fake)
        fake.table[102]?.input = true
        fake.fire(102, kAudioProcessPropertyIsRunningInput)
        fake.fire(FakeDeviceSystem.defaultInput, kAudioDevicePropertyDeviceIsRunningSomewhere)
        XCTAssertEqual(microphoneApps(probe.read(at: t0)), ["com.example.app-2"])
        XCTAssertEqual(fake.flagReads, [101: 1, 102: 2, 103: 1, 104: 1], "a start its own listener explains reads nothing more")

        fake.table[102]?.input = false
        fake.fire(FakeDeviceSystem.defaultInput, kAudioDevicePropertyDeviceIsRunningSomewhere)
        XCTAssertEqual(microphoneApps(probe.read(at: t0)), [], "a stop no process's listener reported")
        XCTAssertEqual(fake.flagReads, [101: 2, 102: 3, 103: 2, 104: 2])

        fake.table[103]?.input = true
        fake.fire(FakeDeviceSystem.defaultInput, kAudioDevicePropertyDeviceIsRunningSomewhere)
        XCTAssertEqual(microphoneApps(probe.read(at: t0)), ["com.example.app-3"], "a start no process's listener reported")
    }

    func testARestartedAudioServerIsListenedToAndReadAfresh() {
        let fake = FakeDeviceSystem(processes: 3)
        let probe = observed(fake)
        let laid = fake.laid
        fake.table[101]?.output = true
        fake.restart()
        XCTAssertEqual(fake.laid, 0)
        XCTAssertEqual(soundApps(probe.read(at: t0)), ["com.example.app-1"])
        XCTAssertEqual(fake.flagReads, [101: 2, 102: 2, 103: 2])
        XCTAssertEqual(fake.laid, laid, "every listener is laid again")

        fake.table[102]?.output = true
        fake.fire(102, kAudioProcessPropertyIsRunningOutput)
        XCTAssertEqual(soundApps(probe.read(at: t0)), ["com.example.app-1", "com.example.app-2"])
    }

    func testARecheckRereadsEveryProcess() throws {
        let fake = FakeDeviceSystem(processes: 4)
        let queue = DispatchQueue(label: "device-use-test")
        let monitor = DeviceUseMonitor(probe: SystemDeviceUseProbe(system: fake, ownPID: 1, ownApp: "org.example.recorder"),
                                       queue: queue)
        var delivered: [DeviceUse] = []
        _ = queue.sync { monitor.start { delivered.append($0) } }
        defer { queue.sync { monitor.stop() } }
        queue.sync { fake.table[104]?.output = true }
        monitor.recheck()
        try until("queue.sync { delivered.count } == 1") { queue.sync { delivered.count } == 1 }
        queue.sync { monitor.stop() }
        XCTAssertEqual(delivered.map(soundApps), [["com.example.app-4"]])
        XCTAssertEqual(fake.flagReads, [101: 2, 102: 2, 103: 2, 104: 2])
    }

    func testAProcessThatLeavesStopsAndIsNoLongerListenedTo() {
        let fake = FakeDeviceSystem(processes: 3)
        fake.table[102]?.input = true
        let probe = observed(fake)
        XCTAssertEqual(microphoneApps(probe.read(at: t0)), ["com.example.app-2"])
        fake.remove(102)
        fake.fire(UInt32(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList)
        XCTAssertEqual(microphoneApps(probe.read(at: t0)), [])
        XCTAssertFalse(fake.isListened(102))
    }

    func testNothingIsTrustedAcrossAPause() {
        let fake = FakeDeviceSystem(processes: 2)
        let probe = observed(fake)
        probe.stopObserving()
        XCTAssertEqual(fake.laid, 0)
        fake.table[101]?.output = true
        XCTAssertEqual(soundApps(probe.read(at: t0)), ["com.example.app-1"])
        fake.table[102]?.output = true
        XCTAssertEqual(soundApps(probe.read(at: t0)), ["com.example.app-1", "com.example.app-2"])
        XCTAssertEqual(fake.flagReads, [101: 3, 102: 3], "a read with nothing observing reads every process")

        fake.table[101]?.output = false
        probe.observe { _ in }
        XCTAssertEqual(soundApps(probe.read(at: t0)), ["com.example.app-2"], "nothing read before the pause is trusted after it")
    }
}

private final class ScriptedProbe: DeviceUseProbe, @unchecked Sendable {
    private var reads: [DeviceUse]
    private let lock = NSLock()
    private var listener: (@Sendable (DeviceUseSignal) -> Void)?
    private(set) var readCount = 0
    private(set) var stopped = false

    init(reads: [DeviceUse]) { self.reads = reads }

    func read(at: Date) -> DeviceUse {
        lock.withLock {
            readCount += 1
            let next = reads.count > 1 ? reads.removeFirst() : reads[0]
            return DeviceUse(at: at, audio: next.audio, cameras: next.cameras)
        }
    }

    func observe(_ signal: @escaping @Sendable (DeviceUseSignal) -> Void) { lock.withLock { listener = signal } }
    func stopObserving() { lock.withLock { listener = nil; stopped = true } }
    func recheck() {}
    func signal(_ kind: DeviceUseSignal) { lock.withLock { listener }?(kind) }
}

private final class FakeDeviceSystem: DeviceSystem, @unchecked Sendable {
    struct Process {
        let app: String
        var input = false
        var output = false
    }

    static let defaultOutput: AudioObjectID = 90
    static let defaultInput: AudioObjectID = 91
    private static let microphone = AudioDeviceFacts(uid: "synthetic-input-uid", name: "Synthetic Microphone", transport: "built_in")
    private static let speakers = AudioDeviceFacts(uid: "synthetic-output-uid", name: "Synthetic Speakers", transport: "built_in")

    private var order: [AudioObjectID] = []
    var table: [AudioObjectID: Process] = [:]
    var unanswered: Set<AudioObjectID> = []
    var refused: Set<AudioObjectID> = []
    var duringRead: ((AudioObjectID) -> Void)?
    private(set) var flagReads: [AudioObjectID: Int] = [:]
    private(set) var listens = 0
    private(set) var calls: [String] = []
    private var listeners: [ListenerKey: @Sendable () -> Void] = [:]

    init(processes count: Int) {
        for index in 1...count { add(AudioObjectID(100 + index)) }
    }

    func add(_ process: AudioObjectID, input: Bool = false) {
        order.append(process)
        table[process] = Process(app: "com.example.app-\(process - 100)", input: input)
    }

    func remove(_ process: AudioObjectID) {
        order.removeAll { $0 == process }
        table[process] = nil
    }

    func fire(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) {
        listeners[ListenerKey(.audio, object, selector, kAudioObjectPropertyScopeGlobal)]?()
    }

    func restart() {
        let restarted = listeners[ListenerKey(.audio, UInt32(kAudioObjectSystemObject), kAudioHardwarePropertyServiceRestarted,
                                              kAudioObjectPropertyScopeGlobal)]
        listeners = [:]
        restarted?()
    }

    var laid: Int { listeners.count }
    func isListened(_ object: AudioObjectID) -> Bool { listeners.keys.contains { $0.object == object } }

    func processes() -> [AudioObjectID]? { order }

    func running(_ process: AudioObjectID) -> ProcessRunning {
        flagReads[process, default: 0] += 1
        calls.append("read \(process)")
        duringRead?(process)
        guard !unanswered.contains(process), let state = table[process] else { return ProcessRunning(input: nil, output: nil) }
        return ProcessRunning(input: state.input, output: state.output)
    }

    func pid(_ process: AudioObjectID) -> pid_t? { table[process].map { _ in pid_t(9000 + process) } }
    func name(_ process: AudioObjectID, pid: pid_t) -> ProcessName {
        ProcessName(app: table[process]?.app ?? "unknown", raw: table[process]?.app ?? "unknown")
    }

    func devices(_ process: AudioObjectID, scope: AudioObjectPropertyScope) -> [AudioDeviceFacts] {
        [scope == kAudioObjectPropertyScopeInput ? Self.microphone : Self.speakers]
    }

    func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioObjectID? {
        selector == kAudioHardwarePropertyDefaultInputDevice ? Self.defaultInput : Self.defaultOutput
    }

    func level(_ device: AudioObjectID?, scope: AudioObjectPropertyScope) -> DeviceLevel {
        DeviceLevel(device: device == Self.defaultInput ? Self.microphone : Self.speakers, volume: 0.5, muted: false)
    }

    func runningSomewhere(_ device: AudioObjectID) -> Bool { table.values.contains { $0.input } }
    func cameras() -> (all: [CMIOObjectID], running: [CameraFacts])? { ([], []) }
    func has(_ key: ListenerKey) -> Bool { true }

    func listen(_ key: ListenerKey, _ heard: @escaping @Sendable () -> Void) -> Bool {
        listens += 1
        guard !refused.contains(key.object) else { return false }
        if calls.last != "listen \(key.object)" { calls.append("listen \(key.object)") }
        listeners[key] = heard
        return true
    }

    func unlisten(_ key: ListenerKey) { listeners[key] = nil }
}
