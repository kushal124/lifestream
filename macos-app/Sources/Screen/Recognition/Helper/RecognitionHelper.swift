import Darwin
import Evidence
import Foundation

protocol HelperProcess: AnyObject, Sendable {
    func exchange(_ request: Data) -> RecognitionWire.Reply?
    func setBackground(_ background: Bool)
    func end()
    func usage() -> ProcessUsage?
}

actor RecognitionHelper {
    struct Pace: Sendable {
        var lift = 3.0
        var restart = 8.0
        var giveUp = 18.0
        var hold = 20.0
        var watch = 0.25
    }

    struct Counts: Equatable, Sendable {
        var lifts = 0
        var restarts = 0
        var failed = 0
    }

    private final class Request: @unchecked Sendable {
        let id: UInt64
        let frame: RawFrame
        let tile: Tile
        let asked: Double
        var continuation: CheckedContinuation<[TextObservation]?, Never>?

        init(id: UInt64, frame: RawFrame, tile: Tile, asked: Double) {
            self.id = id
            self.frame = frame
            self.tile = tile
            self.asked = asked
        }
    }

    private let launch: @Sendable () -> HelperProcess?
    private let lines: FailureLines
    private var unavailable = FailureLines.Streak(closing: .helperBack)
    private let pace: Pace
    private let clock: @Sendable () -> Double
    private var process: HelperProcess?
    private var background = true
    private var liftedAt = -Double.infinity
    private var queue: [Request] = []
    private var running: (request: Request, process: HelperProcess, cpu: UInt64?, progressed: Double)?
    private var pumping = false
    private var nextID: UInt64 = 0
    private nonisolated let ledger = Ledger()
    private(set) var counts = Counts()

    static let shared = RecognitionHelper {
        LaunchedHelper(executable: Bundle.main.executablePath ?? CommandLine.arguments[0])
    }

    static let live: TextRecognizer.Reader = { frame, tile in await shared.read(frame, tile) }

    init(pace: Pace = Pace(), clock: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime },
         lines: FailureLines = .shared, launch: @escaping @Sendable () -> HelperProcess?) {
        self.pace = pace
        self.clock = clock
        self.lines = lines
        self.launch = launch
    }

    func read(_ frame: RawFrame, _ tile: Tile) async -> [TextObservation]? {
        nextID &+= 1
        let request = Request(id: nextID, frame: frame, tile: tile, asked: clock())
        return await withCheckedContinuation { continuation in
            request.continuation = continuation
            queue.append(request)
            if !pumping {
                pumping = true
                Task { await pump() }
                Task { await watch() }
            }
        }
    }

    nonisolated func usage() -> ProcessUsage {
        ledger.total()
    }

    private func pump() async {
        while !queue.isEmpty {
            let request = queue.removeFirst()
            var attempts = 0
            while request.continuation != nil {
                guard clock() - request.asked < pace.giveUp else {
                    finish(request, nil)
                    break
                }
                guard let helper = current() else {
                    finish(request, nil)
                    break
                }
                running = (request, helper, helper.usage()?.cpuNs, clock())
                let reply = await BlockingWork.run {
                    (try? RecognitionWire.request(TileCrop(request.frame, request.tile), id: request.id))
                        .flatMap { helper.exchange($0) }
                }
                running = nil
                if let reply, reply.id == request.id {
                    finish(request, reply.text)
                    break
                }
                retire(helper)
                attempts += 1
                guard request.continuation != nil else { break }
                guard attempts < 2 else {
                    finish(request, nil)
                    break
                }
                counts.restarts += 1
                ResourceMeter.shared.count(.ocrHelperRestarts)
            }
        }
        pumping = false
        if !background, clock() - liftedAt >= pace.hold {
            background = true
            process?.setBackground(true)
        }
    }

    private func watch() async {
        while pumping {
            try? await Task.sleep(nanoseconds: UInt64(pace.watch * 1e9))
            let now = clock()
            for request in [running?.request].compactMap({ $0 }) + queue where now - request.asked >= pace.giveUp {
                finish(request, nil)
            }
            queue.removeAll { $0.continuation == nil }
            let waiting = [running?.request].compactMap { $0 } + queue
            if let oldest = waiting.filter({ $0.continuation != nil }).map(\.asked).min(), now - oldest >= pace.lift {
                liftedAt = now
                if background {
                    background = false
                    counts.lifts += 1
                    ResourceMeter.shared.count(.ocrHelperLifts)
                    process?.setBackground(false)
                }
            }
            if var running {
                if let cpu = running.process.usage()?.cpuNs, cpu != running.cpu {
                    running.cpu = cpu
                    running.progressed = now
                    self.running = running
                } else if now - running.progressed >= pace.restart {
                    running.process.end()
                }
            }
        }
    }

    private func current() -> HelperProcess? {
        if let process { return process }
        guard let started = launch() else {
            unavailable.failed(.helperUnavailable, lines: lines)
            return nil
        }
        unavailable.ended(lines: lines)
        started.setBackground(background)
        process = started
        ledger.started(started)
        return started
    }

    private func retire(_ helper: HelperProcess) {
        ledger.retired(helper)
        helper.end()
        if process === helper { process = nil }
    }

    private func finish(_ request: Request, _ text: [TextObservation]?) {
        guard let continuation = request.continuation else { return }
        request.continuation = nil
        if text == nil {
            counts.failed += 1
            ResourceMeter.shared.count(.ocrReadsFailed)
        }
        continuation.resume(returning: text)
    }
}

extension RecognitionHelper {
    final class Ledger: @unchecked Sendable {
        private let lock = NSLock()
        private var ended = ProcessUsage()
        private var running: HelperProcess?

        func started(_ process: HelperProcess) {
            lock.withLock { running = process }
        }

        func retired(_ process: HelperProcess) {
            let last = process.usage()
            lock.withLock {
                if let last { ended = ended.adding(last) }
                if running === process { running = nil }
            }
        }

        func total() -> ProcessUsage {
            let process = lock.withLock { running }
            let now = process?.usage()
            return lock.withLock { now.map { ended.adding($0) } ?? ended }
        }
    }
}

public enum TextRecognitionHelper {
    public static func usage() -> ProcessUsage {
        RecognitionHelper.shared.usage()
    }
}
