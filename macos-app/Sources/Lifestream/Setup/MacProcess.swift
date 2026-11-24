import Audio
import DeviceFiles
import Evidence
import Foundation
import Passwords
import Shipping

final class MacProcess: @unchecked Sendable {
    enum Opened: Equatable {
        case open
        case refused(String)
        case startedAgain
    }

    static let refusedWords = "Lifestream can't open what this Mac records. Click Allow."
    static let helperRefusedWords = "Open Lifestream and click Allow."
    static let deniedWords = "macOS didn't let Lifestream read its key. Click Allow again, and when macOS asks, choose Always Allow."

    let name: SealWork.Process
    let plain: DeviceFiles
    let scratch: URL
    let macFiles: MacFiles
    private let lock = NSLock()
    private var state: Opened
    private var held: DeviceFiles?

    var opened: Opened { lock.withLock { state } }
    var files: DeviceFiles? { lock.withLock { held } }

    private static let starting = NSLock()
    nonisolated(unsafe) private static var started: MacProcess?

    static var current: MacProcess {
        guard let started = starting.withLock({ started }) else {
            preconditionFailure("MacProcess.current was read before Main.run opened this process")
        }
        return started
    }

    static func start(_ name: SealWork.Process, spool: URL) {
        let opened = MacProcess.opened(name, spool: spool)
        starting.withLock {
            precondition(started == nil, "a process opened its files twice")
            started = opened
        }
    }

    static func opened(_ name: SealWork.Process, spool: URL, machine: URL = MachineDirectory.url, ship: URL = ShippingState.defaultRoot,
                       keys: HomeKeys = HomeKeys(reader: .app), watcher: MacFiles.Watcher = MacProcess.watcher) -> MacProcess {
        _ = ResourceMeter.shared
        let plain = DeviceFiles(.plain)
        let key = keys.reading(as: name == .app ? .app : .helper).macFiles
        let macFiles = MacFiles(machine: machine, spool: spool, ship: ship, key: key, plain: plain, watcher: watcher)
        let scratch = SealWork.scratch(machine: machine, name)
        let (state, files) = applied(macFiles.open())
        empty(scratch, keeping: [AudioSpool.directoryName])
        return MacProcess(name, plain: plain, scratch: scratch, macFiles: macFiles, state: state, files: files)
    }

    private init(_ name: SealWork.Process, plain: DeviceFiles, scratch: URL, macFiles: MacFiles, state: Opened, files: DeviceFiles?) {
        self.name = name
        self.plain = plain
        self.scratch = scratch
        self.macFiles = macFiles
        self.state = state
        held = files
    }

    private static func applied(_ opened: MacFiles.Opened) -> (Opened, DeviceFiles?) {
        switch opened {
        case .files(let files): return (.open, files)
        case .startedAgain(let files): return (.startedAgain, files)
        case .refused(let why): return (.refused(why), nil)
        }
    }

    func becomeKeyed() throws {
        guard let files else { throw MacFiles.Refusal.keychain(refusal() ?? Self.refusedWords) }
        try macFiles.becomeKeyed(files)
    }

    func allow() -> Opened {
        let opened: Opened = lock.withLock {
            guard case .refused = state else { return state }
            (state, held) = Self.applied(macFiles.open(reading: Self.prompted))
            return state
        }
        if opened == .open { macFiles.watcher.start() }
        return opened
    }

    private static func prompted(_ key: HomeKey) -> KeyFound {
        let found = key.prompted()
        if case .refused = found { return .refused(deniedWords) }
        return found
    }

    func writing() throws -> DeviceFiles {
        guard let files else { throw UsageError.message(refusal() ?? Self.helperRefusedWords) }
        return files
    }

    func refusal() -> String? {
        guard case .refused = opened else { return nil }
        return name == .app ? Self.refusedWords : Self.helperRefusedWords
    }

    static func empty(_ scratch: URL, keeping kept: [String]) {
        let manager = FileManager.default
        try? SealWork.prepare(scratch)
        for name in (try? manager.contentsOfDirectory(atPath: scratch.path)) ?? [] where !kept.contains(name) {
            try? manager.removeItem(at: scratch.appendingPathComponent(name))
        }
    }

    static let watcher = MacFiles.Watcher(stop: {
        HomeAgents.stopWatcher()
    }, start: {
        HomeAgents.startWatcher()
    })
}
