import AppKit
import Combine
import Foundation
import SystemConfiguration

@MainActor final class SetupHost: NSObject {
    struct Placement: Encodable, Equatable {
        let moving: Bool
        let error: String?
    }

    struct Machine: Encodable, Equatable {
        let folder: String
        let freeBytes: Double?
        let daysOfRoom: Int?
        let name: String?
        var home: FolderHome? = nil
        var disk: Disk? = nil

        static func of(_ folder: URL, look: MachineLook?, name: String?) -> Machine {
            Machine(folder: (folder.standardizedFileURL.path as NSString).abbreviatingWithTildeInPath,
                    freeBytes: look?.folder?.free_bytes,
                    daysOfRoom: look?.folder.map { Runway.days(free: $0.free_bytes) }, name: name,
                    home: look?.folder.map(FolderHome.of), disk: look?.disk)
        }

        private enum CodingKeys: String, CodingKey {
            case folder, name, home, disk
            case freeBytes = "free_bytes"
            case daysOfRoom = "days_of_room"
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(folder, forKey: .folder)
            try container.encode(freeBytes, forKey: .freeBytes)
            try container.encode(daysOfRoom, forKey: .daysOfRoom)
            try container.encode(name, forKey: .name)
            try container.encode(home?.word, forKey: .home)
            try container.encode(disk, forKey: .disk)
        }
    }

    struct Setup: Encodable, Equatable {
        let state: String
        let error: String?
        var waiting: String? = nil
        var key: SetupKey.Shown? = nil

        private enum CodingKeys: String, CodingKey {
            case state, error, waiting, key
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(state, forKey: .state)
            try container.encode(error, forKey: .error)
            try container.encode(waiting, forKey: .waiting)
            try container.encode(key, forKey: .key)
        }
    }

    var changed: () -> Void = {}

    let placed: Bool
    let start: SetupStart
    let name: String
    private(set) var folder: URL
    private var looked: (folder: URL, look: MachineLook)?
    var look: MachineLook? { looked?.folder == folder ? looked?.look : nil }
    private var lookProblem: String?
    private var moving = false
    private var placeFailure: String?
    let key = SetupKey()
    private var phase: AnyCancellable?
    private var active: NSObjectProtocol?

    let item: URL
    private let release: BundledRelease?
    private let steps: StartSteps?
    private let place: @Sendable () throws -> AppPlacement.Placed
    private let reopen: (AppPlacement.Placed) throws -> Void
    private let quit: () -> Void
    private let defaults: UserDefaults

    static let keyFolder = "setup.keyFolder"

    init(world: SetupWorld, start: SetupStart, release: BundledRelease?, steps: StartSteps?,
         name: String = SetupHost.computerName(), look: MachineLook? = nil, item: URL = AppPlacement.original(),
         place: @escaping @Sendable () throws -> AppPlacement.Placed = { try AppPlacement.place() },
         reopen: @escaping (AppPlacement.Placed) throws -> Void = { try AppRestart.reopen($0.app, ejecting: $0.volume) },
         defaults: UserDefaults = .standard, quit: @escaping () -> Void) {
        placed = world.placed
        self.start = start
        self.release = release
        self.steps = steps
        self.name = name
        self.defaults = defaults
        let keyAt = world.folder == nil ? defaults.string(forKey: Self.keyFolder).map { URL(fileURLWithPath: $0, isDirectory: true) } : nil
        if world.folder != nil { defaults.removeObject(forKey: Self.keyFolder) }
        let folder = world.folder ?? keyAt ?? Self.standardFolder
        self.folder = folder
        looked = look.map { (folder, $0) }
        self.item = item
        self.place = place
        self.reopen = reopen
        self.quit = quit
        super.init()
        key.changed = { [weak self] in self?.changed() }
        phase = start.$phase.dropFirst().sink { [weak self] _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.changed() } }
        }
        active = NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil,
                                                        queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if self?.start.phase == .loginItems { Task { await self?.setUp() } } }
        }
        if placed, keyAt != nil {
            Task { await resumeKey() }
        } else if placed, look == nil {
            Task { await lookAgain() }
        }
    }

    private func resumeKey() async {
        if look == nil { await lookAgain() }
        guard let looked = look?.folder, FolderHome.of(looked) == .new else {
            return defaults.removeObject(forKey: Self.keyFolder)
        }
        await setUp()
    }

    nonisolated static func computerName() -> String {
        (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? Host.current().localizedName ?? "This Mac"
    }


    var placement: Placement? { placed ? nil : Placement(moving: moving, error: placeFailure) }

    var machine: Machine { .of(folder, look: look, name: name) }

    var setup: Setup {
        if let shown = key.shown { return Setup(state: "key", error: nil, key: shown) }
        switch start.phase {
        case .running, .locked: return Setup(state: "working", error: nil)
        case .starting(let words): return Setup(state: "working", error: nil, waiting: words)
        case .done: return Setup(state: "done", error: nil)
        case .loginItems: return Setup(state: "login-items", error: nil)
        case .refused(let words): return Setup(state: "failed", error: words)
        case .failed(let details): return Setup(state: "failed", error: details.components(separatedBy: "\n\n").first ?? details)
        case .idle: return Setup(state: refusal == nil ? "idle" : "failed", error: refusal)
        }
    }

    private var refusal: String? {
        if let folder = look?.folder {
            return folder.refused ?? Runway.full(free: folder.free_bytes)
        }
        return lookProblem
    }


    func lookAgain() async {
        guard let release else {
            lookProblem = "This copy of Lifestream is incomplete. Download it again."
            return changed()
        }
        let folder = folder
        lookProblem = nil
        do {
            let look = try await Task.detached { try MachineLook.read(folder, release: release) }.value
            guard self.folder == folder else { return }
            looked = (folder, look)
        } catch {
            guard self.folder == folder else { return }
            looked = nil
            lookProblem = "\(error)"
        }
        changed()
    }

    nonisolated static var standardFolder: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Lifestream", isDirectory: true)
    }

    nonisolated static func panelStart(drives: Bool) -> URL {
        drives ? URL(fileURLWithPath: "/Volumes", isDirectory: true) : FileManager.default.homeDirectoryForCurrentUser
    }

    func chooseFolder(_ choice: HostAct.FolderChoice, over window: NSWindow?) async throws {
        guard !working else { throw HostRefusal("Lifestream is setting up in the folder chosen.") }
        guard case .panel(let drives) = choice else {
            if folder.standardizedFileURL != Self.standardFolder.standardizedFileURL { choose(Self.standardFolder) }
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Choose"
        panel.message = "Choose the folder Lifestream keeps everything in."
        panel.directoryURL = Self.panelStart(drives: drives)
        let answer = if let window { await panel.beginSheetModal(for: window) } else { panel.runModal() }
        guard answer == .OK, let chosen = panel.url else { return }
        choose(chosen)
    }

    func choose(_ chosen: URL) {
        guard !working else { return }
        folder = chosen
        looked = nil
        start.folderChanged()
        changed()
        Task { await lookAgain() }
    }

    private var working: Bool {
        switch start.phase {
        case .running, .starting, .loginItems, .locked, .done: true
        case .idle, .refused, .failed: false
        }
    }

    func setUp() async {
        guard let steps else {
            return start.cannotBegin("This copy of Lifestream is incomplete. Download it again.")
        }
        if look == nil { await lookAgain() }
        guard let looked = look?.folder else {
            return start.cannotBegin(lookProblem ?? "Lifestream did not say where it answers.")
        }
        guard refusal == nil else { return }
        start.begin(steps, folder: folder, door: looked.door, name: name, home: FolderHome.of(looked),
                    show: { [key, defaults] drafted, folder in
                        defaults.set(folder.path, forKey: SetupHost.keyFolder)
                        let saved = await key.show(drafted, folder: folder)
                        defaults.removeObject(forKey: SetupHost.keyFolder)
                        return saved
                    })
        changed()
    }


    var image: URL? { AppPlacement.diskImage(of: item) }

    func opensWindow(_ plan: AppPlacement.Plan = AppPlacement.plan()) -> Bool {
        if openPlacedCopy(plan) { return false }
        if let image {
            NSWorkspace.shared.open(image)
            quit()
            return false
        }
        return true
    }

    @discardableResult
    func openPlacedCopy(_ plan: AppPlacement.Plan) -> Bool {
        guard case .open = plan else { return false }
        do {
            let app = try AppPlacement.carry(plan)
            try reopen(AppPlacement.Placed(app: app, volume: image))
            quit()
            return true
        } catch {
            fail(error)
            return false
        }
    }

    func move() throws {
        guard !placed else { throw HostRefusal("Lifestream is in Applications already.") }
        guard !moving else { return }
        moving = true
        placeFailure = nil
        changed()
        Task {
            do {
                let placed = try await Task.detached { [place] in try place() }.value
                try reopen(placed)
                quit()
            } catch {
                fail(error)
            }
        }
    }

    private func fail(_ error: Error) {
        moving = false
        placeFailure = "Lifestream couldn’t copy itself to Applications. \(error.localizedDescription) Drag it to Applications in the Finder, then open it from there."
        changed()
    }
}
