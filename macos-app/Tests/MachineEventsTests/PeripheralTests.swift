import XCTest
import DeviceFiles
import Evidence
@testable import MachineEvents

final class PeripheralTests: XCTestCase {
    private let t0 = UTCInstant.date(rfc3339: "2026-09-30T10:00:00.000Z")!

    private let builtIn = DisplayFacts(id: 1, name: "Synthetic Built-in Display", builtIn: true, main: true,
                                       x: 0, y: 0, width: 1512, height: 982, pixelWidth: 3024, pixelHeight: 1964,
                                       widthMM: 301.5, heightMM: 195.5, mirrorOf: nil)
    private let external = DisplayFacts(id: 7, name: "Synthetic Monitor", builtIn: false, main: false,
                                        x: 1512, y: -400, width: 2560, height: 1440, pixelWidth: 5120, pixelHeight: 2880,
                                        widthMM: 597, heightMM: 336, mirrorOf: nil)
    private let headphones = BluetoothFacts(address: "00-00-5e-00-53-01", name: "Synthetic Headphones", classOfDevice: 0x240418)
    private let keyboard = BluetoothFacts(address: "00-00-5e-00-53-02", name: "Synthetic Keyboard", classOfDevice: 0x002540)

    private func names(_ events: [MachineEvent]) -> [String] { events.map(\.name.rawValue) }

    private func moved(_ display: DisplayFacts, x: Double, main: Bool? = nil, name: String?? = .none) -> DisplayFacts {
        DisplayFacts(id: display.id, name: name ?? display.name, builtIn: display.builtIn, main: main ?? display.main,
                     x: x, y: display.y, width: display.width, height: display.height,
                     pixelWidth: display.pixelWidth, pixelHeight: display.pixelHeight,
                     widthMM: display.widthMM, heightMM: display.heightMM, mirrorOf: display.mirrorOf)
    }


    func testDisplaysThatComeGoAndMoveWriteTheirLines() {
        let attached = PeripheralEvents.displays(from: [builtIn], to: [external, builtIn], at: t0)
        XCTAssertEqual(names(attached), ["display_attach"])
        XCTAssertEqual(attached[0].detail["display"], .number(7))
        XCTAssertEqual(attached[0].at, t0)

        let detached = PeripheralEvents.displays(from: [builtIn, external], to: [builtIn], at: t0)
        XCTAssertEqual(names(detached), ["display_detach"])
        XCTAssertEqual(detached[0].detail["name"], .text("Synthetic Monitor"), "a detach states the display as last read")

        let rearranged = PeripheralEvents.displays(
            from: [builtIn, external],
            to: [moved(builtIn, x: 2560, main: false), moved(external, x: 0, main: true)], at: t0)
        XCTAssertEqual(names(rearranged), ["display_change", "display_change"])
        XCTAssertEqual(rearranged.map { $0.detail["display"] }, [.number(1), .number(7)], "in display order")

        let swapped = PeripheralEvents.displays(
            from: [builtIn, external], to: [moved(builtIn, x: 0, name: .some(nil)), external], at: t0)
        XCTAssertEqual(swapped, [], "a name learnt or lost alone is no change in the arrangement")

        let both = PeripheralEvents.displays(from: [external], to: [builtIn], at: t0)
        XCTAssertEqual(names(both), ["display_detach", "display_attach"], "detaches before attaches")
    }

    func testAnUnreadDisplayListWritesNothing() {
        XCTAssertEqual(PeripheralEvents.displays(from: nil, to: [builtIn, external], at: t0), [],
                       "the first read is the state line's, not attaches")
        XCTAssertEqual(PeripheralEvents.displays(from: [builtIn, external], to: nil, at: t0), [],
                       "a list the system did not answer detaches nothing")
    }

    func testADisplayLineIsPinnedBytes() throws {
        let attached = PeripheralEvents.displays(from: [builtIn], to: [builtIn, external], at: t0)
        XCTAssertEqual(try MachineEventCodec.line(attached[0]),
                       "{\"at\":\"2026-09-30T10:00:00.000Z\",\"event\":\"display_attach\",\"detail\":{"
                       + "\"built_in\":false,\"display\":7,\"height\":1440,\"height_mm\":336,\"main\":false,"
                       + "\"name\":\"Synthetic Monitor\",\"pixel_height\":2880,\"pixel_width\":5120,"
                       + "\"width\":2560,\"width_mm\":597,\"x\":1512,\"y\":-400}}")
        let withheld = DisplayFacts(id: 9, name: nil, builtIn: false, main: false, x: 0, y: 0, width: 1920, height: 1080,
                                    pixelWidth: nil, pixelHeight: nil, widthMM: nil, heightMM: nil, mirrorOf: 1)
        let mirrored = PeripheralEvents.displays(from: [builtIn], to: [builtIn, withheld], at: t0)
        XCTAssertEqual(try MachineEventCodec.line(mirrored[0]),
                       "{\"at\":\"2026-09-30T10:00:00.000Z\",\"event\":\"display_attach\",\"detail\":{"
                       + "\"built_in\":false,\"display\":9,\"height\":1080,\"main\":false,\"mirror_of\":1,"
                       + "\"name_unavailable\":true,\"physical_size_unavailable\":true,\"pixel_size_unavailable\":true,"
                       + "\"width\":1920,\"x\":0,\"y\":0}}")
    }


    func testABluetoothDeviceConnectsOnceAndDisconnectsOnce() {
        var held: [BluetoothFacts]? = [headphones]
        var lines: [MachineEvent] = []
        func apply(_ connected: Bool, _ device: BluetoothFacts) {
            let change = PeripheralEvents.bluetooth(connected: connected, device, held: held, at: t0)
            held = change.held
            lines += change.events
        }
        apply(true, headphones)
        XCTAssertEqual(lines, [], "listening replays a device the state line already states")
        apply(true, keyboard)
        apply(true, keyboard)
        XCTAssertEqual(names(lines), ["bluetooth_connect"])
        apply(false, headphones)
        apply(false, headphones)
        XCTAssertEqual(names(lines), ["bluetooth_connect", "bluetooth_disconnect"])
        XCTAssertEqual(held, [keyboard])

        let renamed = BluetoothFacts(address: keyboard.address, name: "Synthetic Keyboard 2", classOfDevice: keyboard.classOfDevice)
        apply(true, renamed)
        XCTAssertEqual(names(lines), ["bluetooth_connect", "bluetooth_disconnect"], "one address is one device")

        let unread = PeripheralEvents.bluetooth(connected: false, headphones, held: nil, at: t0)
        XCTAssertEqual(names(unread.events), ["bluetooth_disconnect"])
        XCTAssertEqual(unread.held, [])
        let first = PeripheralEvents.bluetooth(connected: true, headphones, held: nil, at: t0)
        XCTAssertEqual(names(first.events), ["bluetooth_connect"])
        XCTAssertEqual(first.held, [headphones])
    }

    func testABluetoothLineIsPinnedBytes() throws {
        let connect = PeripheralEvents.bluetooth(connected: true, headphones, held: [], at: t0).events[0]
        XCTAssertEqual(try MachineEventCodec.line(connect),
                       "{\"at\":\"2026-09-30T10:00:00.000Z\",\"event\":\"bluetooth_connect\",\"detail\":{"
                       + "\"address\":\"00-00-5e-00-53-01\",\"class_of_device\":2360344,\"major\":\"audio_video\","
                       + "\"minor\":\"headphones\",\"name\":\"Synthetic Headphones\"}}")
        XCTAssertEqual(PeripheralEvents.bluetooth(connected: true, keyboard, held: [], at: t0).events[0].detail["minor"],
                       .text("keyboard"))
        let trackpad = BluetoothFacts(address: "00-00-5e-00-53-03", name: nil, classOfDevice: 0x002594)
        XCTAssertEqual(PeripheralEvents.bluetooth(connected: true, trackpad, held: [], at: t0).events[0].detail,
                       ["address": .text("00-00-5e-00-53-03"), "name_unavailable": .flag(true),
                        "class_of_device": .number(0x002594), "major": .text("peripheral"),
                        "minor": .text("pointing+digitizer_tablet")])
        let phone = BluetoothFacts(address: "00-00-5e-00-53-04", name: "Synthetic Phone", classOfDevice: 0x7A020C)
        XCTAssertEqual(PeripheralEvents.bluetooth(connected: true, phone, held: [], at: t0).events[0].detail["minor"],
                       .text("smartphone"))
        let unclassed = BluetoothFacts(address: nil, name: "Synthetic Tag", classOfDevice: 0)
        XCTAssertEqual(PeripheralEvents.bluetooth(connected: true, unclassed, held: [], at: t0).events[0].detail,
                       ["address_unavailable": .flag(true), "name": .text("Synthetic Tag"),
                        "class_of_device": .number(0)],
                       "a class of zero names no class")
    }


    func testTheLightIsStatedOnlyWhenItChangesMeaningfullyAndHolds() throws {
        var rule = LightRule(stated: 67)
        var lines: [MachineEvent] = []
        func read(_ lux: Double?, uncovered: Bool = true) {
            if let event = rule.read(lux, uncovered: uncovered, at: t0) { lines.append(event) }
        }
        for lux in [74.0, 90, 120, 60, 40] { read(lux) }
        XCTAssertEqual(lines, [], "a change under a factor of two is no change")
        read(400)
        read(70)
        XCTAssertEqual(lines, [], "a flicker of one read is not stated")
        read(400)
        read(380)
        XCTAssertEqual(names(lines), ["ambient_light"])
        XCTAssertEqual(try MachineEventCodec.line(lines[0]),
                       "{\"at\":\"2026-09-30T10:00:00.000Z\",\"event\":\"ambient_light\",\"detail\":{\"lux\":380}}")
        XCTAssertEqual(rule.stated, 380)

        read(0, uncovered: false)
        read(0, uncovered: false)
        read(0, uncovered: false)
        XCTAssertEqual(lines.count, 1, "a closed lid or a sleeping display states nothing")
        read(0)
        read(nil)
        read(0)
        XCTAssertEqual(lines.count, 1, "an unanswered read breaks the hold")
        read(3)
        XCTAssertEqual(lines.count, 2)
        XCTAssertEqual(lines[1].detail, ["lux": .number(3)])

        var dark = LightRule(stated: 0)
        for lux in [5.0, 12, 19, 8] { if let event = dark.read(lux, uncovered: true, at: t0) { lines.append(event) } }
        XCTAssertEqual(lines.count, 2, "under 10 lux counts as 10, so a dark room's noise is no change")

        var unread = LightRule(stated: nil)
        XCTAssertNil(unread.read(50, uncovered: true, at: t0))
        XCTAssertEqual(unread.read(52, uncovered: true, at: t0)?.detail, ["lux": .number(52)],
                       "a sensor unread at start is stated once it reads and holds")
    }


    func testTheStateLineStatesThePeripherals() {
        let read = Peripherals(displays: [external, builtIn], bluetooth: [keyboard, headphones], lux: 67)
        XCTAssertEqual(PeripheralEvents.stateDetail(read), [
            "displays": .number(2), "display_names": .text("Synthetic Built-in Display, Synthetic Monitor"),
            "bluetooth_connected": .number(2), "bluetooth_names": .text("Synthetic Headphones, Synthetic Keyboard"),
            "ambient_lux": .number(67),
        ])
        let none = Peripherals(displays: [], bluetooth: [], lux: nil)
        XCTAssertEqual(PeripheralEvents.stateDetail(none), [
            "displays": .number(0), "bluetooth_connected": .number(0), "ambient_light_unavailable": .flag(true),
        ])
        XCTAssertEqual(PeripheralEvents.stateDetail(Peripherals(displays: nil, bluetooth: nil, lux: nil)), [
            "displays_unavailable": .flag(true), "bluetooth_unavailable": .flag(true),
            "ambient_light_unavailable": .flag(true),
        ])
        XCTAssertEqual(PeripheralEvents.stateDetail(nil), [
            "displays_unavailable": .flag(true), "bluetooth_unavailable": .flag(true),
            "ambient_light_unavailable": .flag(true),
        ], "unread is unavailable, never empty")
        var state = MachineState()
        state.peripherals = read
        XCTAssertEqual(state.detail["display_names"], .text("Synthetic Built-in Display, Synthetic Monitor"))
    }


    func testThePeripheralsReachTheOpenBatch() throws {
        let now = MachineReader.state()
        guard now.displayAwake, now.lidOpen != false else {
            throw XCTSkip("the light is read only while the display is awake and the lid open")
        }
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("peripheral-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let probe = ScriptedPeripherals(first: Peripherals(displays: [builtIn], bluetooth: [headphones], lux: 67),
                                        lux: [68, 400, 410])
        let sources = MachineEventSources(directory: root, files: DeviceFiles(.plain), timeZone: TimeZone(identifier: "Asia/Kolkata")!,
                                          peripherals: probe, lightInterval: 0.02)
        sources.start()
        defer { sources.stop() }
        let at = Date()
        probe.send(.connected(headphones, at: at))
        probe.send(.displays([builtIn, external], at: at))
        probe.send(.connected(keyboard, at: at))
        probe.send(.disconnected(headphones, at: at))

        let open = root.appendingPathComponent(MachineEventBatch.directoryName)
            .appendingPathComponent(MachineEventBatch.openName)
        let wanted = ["display_attach", "bluetooth_connect", "bluetooth_disconnect", "ambient_light"]
        var written: [MachineEvent] = []
        try until("let text = (try? String(contentsOf: open, encoding: .utf8)) ?? \"\"") {
            let text = (try? String(contentsOf: open, encoding: .utf8)) ?? ""
            written = text.split(separator: "\n").compactMap { try? MachineEventCodec.event(String($0)) }
            return written.filter { wanted.contains($0.name.rawValue) }.count == wanted.count
        }
        XCTAssertEqual(written.first?.name, .state)
        XCTAssertEqual(written.first?.detail["bluetooth_names"], .text("Synthetic Headphones"),
                       "the batch's state line states the first read")
        XCTAssertEqual(written.first?.detail["ambient_lux"], .number(67))
        XCTAssertEqual(names(written).filter { wanted.contains($0) }, wanted, "in the order the probe reported them")
        XCTAssertEqual(written.first { $0.name == .ambientLight }?.detail, ["lux": .number(410)])
        XCTAssertEqual(written.first { $0.name == .bluetoothConnect }?.detail["name"], .text("Synthetic Keyboard"))
        XCTAssertEqual(written.first { $0.name == .displayAttach }?.at, UTCInstant.millisecond(at), "a line carries the instant the system reported")
    }
}

final class ScriptedPeripherals: PeripheralProbe, @unchecked Sendable {
    private let first: Peripherals
    private var answers: [Double?]
    private let lock = NSLock()
    private var queue: DispatchQueue?
    private var changed: ((PeripheralSignal) -> Void)?

    init(first: Peripherals, lux answers: [Double?]) {
        self.first = first
        self.answers = answers
    }

    func start(queue: DispatchQueue, changed: @escaping (PeripheralSignal) -> Void) -> Peripherals {
        lock.withLock {
            self.queue = queue
            self.changed = changed
        }
        return first
    }

    func stop() {
        lock.withLock { changed = nil }
    }

    func lux() -> Double? {
        lock.withLock { answers.count > 1 ? answers.removeFirst() : answers.first ?? nil }
    }

    func send(_ signal: PeripheralSignal) {
        let (queue, changed) = lock.withLock { (self.queue, self.changed) }
        queue?.async { changed?(signal) }
    }
}
