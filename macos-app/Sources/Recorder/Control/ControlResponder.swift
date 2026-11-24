import Evidence
import Foundation

@MainActor public final class ControlResponder {
    private let recorder: Recorder
    private let kept: KeptPause
    private let ship: (@MainActor () async -> String)?
    private let pair: (@MainActor (_ name: String, _ code: String) async -> ControlResponse)?
    public private(set) var shuttingDown = false

    public init(recorder: Recorder, kept: KeptPause = KeptPause(), ship: (@MainActor () async -> String)? = nil,
                pair: (@MainActor (_ name: String, _ code: String) async -> ControlResponse)? = nil) {
        self.recorder = recorder
        self.kept = kept
        self.ship = ship
        self.pair = pair
    }

    public var paused: Bool { kept.paused }

    public func start(duration: Double? = nil) throws {
        if duration == nil { kept.keep(false) }
        try recorder.start(duration: duration)
    }

    public func pause() async {
        kept.keep(true)
        await recorder.stop()
    }

    public func respond(to request: ControlRequest) async -> ControlResponse {
        guard !shuttingDown else { return ControlResponse(ok: false, state: "shutting_down") }
        let action = ControlAction(rawValue: request.action)
        var shipping: String?
        if action == .modes { return modes(request) }
        if action == .pair {
            guard let pair, let name = request.name, let code = request.code else {
                return ControlResponse(ok: false, state: "error", message: "This app does not pair over its control socket")
            }
            return await pair(name, code)
        }
        do {
            switch action {
            case .start:
                try start(duration: request.durationSeconds)
            case .pause:
                await pause()
            case .shutdown:
                beginShutdown()
                await recorder.stop()
            case .ship:
                shipping = await ship?() ?? "no_home"
            case .status, .modes, .pair, nil:
                break
            }
        } catch {
            return ControlResponse(ok: false, state: "error",
                                   message: "Unable to start recorder; check storage ownership and permissions")
        }
        let status = recorder.status
        let carried = shipping ?? ""
        let refused = ["unreachable", "refused", "held", "conflict"].contains { carried.hasPrefix($0) }
        return ControlResponse(ok: (action != .start || recorder.running) && !refused,
                               state: shuttingDown ? "shutting_down" : status.state.rawValue,
                               message: status.message, captures: status.recorded, gaps: status.gaps,
                               pendingFrames: status.pendingFrames,
                               videoCompactionStatus: status.videoCompactionStatus?.rawValue,
                               pendingVideoImages: status.pendingVideoImages,
                               pendingVideoBytes: status.pendingVideoBytes,
                               shipping: shipping)
    }

    private func modes(_ request: ControlRequest) -> ControlResponse {
        let state = recorder.status.state.rawValue
        guard let change = request.modeChange else {
            guard request.mode == nil, request.bundleID == nil, request.site == nil else {
                return ControlResponse(ok: false, state: state, message: "Invalid control request",
                                       modes: recorder.modes.listing)
            }
            return ControlResponse(ok: true, state: state, modes: recorder.modes.listing)
        }
        do {
            try recorder.setMode(change.mode, for: change.target)
            return ControlResponse(ok: true, state: state, modes: recorder.modes.listing)
        } catch let refusal as RecordingModesError {
            return ControlResponse(ok: false, state: state, message: refusal.localizedDescription,
                                   modes: recorder.modes.listing)
        } catch {
            return ControlResponse(ok: false, state: state,
                                   message: "The mode applies until the app quits; it could not be kept",
                                   modes: recorder.modes.listing)
        }
    }

    public func beginShutdown() {
        shuttingDown = true
    }
}
