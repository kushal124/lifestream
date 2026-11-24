import CallKit
import Cockpit
import LifestreamCaptureCore
import SwiftUI
import UIKit

struct VigilanceView: View {
    @ObservedObject var session: VigilanceSession
    @ObservedObject var model: CheckInModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var saved = false
    @State private var previousIdle = false
    var body: some View {
        Group {
            if saved, let record = session.record {
                VigilanceResultView(record: record, history: model.status.history, model: model)
            } else if session.record != nil {
                Group {
                    if let error = model.error {
                        InPlaceLine(error) { persist() }
                    } else {
                        VStack(spacing: Cockpit.Space.s4) {
                            Loading(size: .inline)
                            Text("Saving every tap").cockpit(.footnote).foregroundStyle(Cockpit.Color.textSecondary)
                        }
                    }
                }
                .padding(Cockpit.Space.s4)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .groundColor(Cockpit.Color.surface)
            } else {
                VigilanceTouchView(session: session).ignoresSafeArea()
                    .accessibilityIdentifier("checkin.vigilance")
            }
        }
        .interactiveDismissDisabled(session.record == nil)
        .onAppear { previousIdle = UIApplication.shared.isIdleTimerDisabled; UIApplication.shared.isIdleTimerDisabled = true }
        .onChange(of: session.record == nil) { _, empty in
            if !empty { UIApplication.shared.isIdleTimerDisabled = previousIdle; persist() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                session.interrupt("background", clock: CACurrentMediaTime())
                session.finish(completed: false, clock: CACurrentMediaTime())
                persist()
            }
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = previousIdle
            session.finish(completed: false, clock: CACurrentMediaTime())
            if !saved { persist() }
        }
    }
    private func persist() {
        guard let record = session.record else { return }
        let lease = CheckInSaveLease()
        Task {
            defer { lease.end() }
            if await model.saveVigilance(record) { saved = true }
        }
    }
}

private struct VigilanceTouchView: UIViewRepresentable {
    let session: VigilanceSession
    func makeUIView(context: Context) -> VigilanceTouchSurface { VigilanceTouchSurface(session: session) }
    func updateUIView(_ uiView: VigilanceTouchSurface, context: Context) {}
    static func dismantleUIView(_ uiView: VigilanceTouchSurface, coordinator: ()) { uiView.stop() }
}

private final class VigilanceTouchSurface: UIView, CXCallObserverDelegate {
    private let session: VigilanceSession
    private var link: CADisplayLink?
    private let box = UIView()
    private let counter = UILabel()
    private let hint = UILabel()
    private let progress = UIView()
    private let calls = CXCallObserver()
    private let ink = UIColor(Cockpit.Color.text)
    private let feedbackInk = UIColor(Cockpit.Color.textSecondary)
    private let edge = UIColor(Cockpit.Color.border)
    init(session: VigilanceSession) {
        self.session = session
        super.init(frame: .zero)
        overrideUserInterfaceStyle = .dark
        backgroundColor = UIColor(Cockpit.Color.canvas)
        isMultipleTouchEnabled = false
        box.layer.cornerRadius = Cockpit.Radius.sm; box.layer.cornerCurve = .continuous
        box.layer.borderWidth = Cockpit.Stroke.border
        counter.font = .monospacedSystemFont(ofSize: 56, weight: .medium)
        counter.textAlignment = .center
        hint.font = .preferredFont(forTextStyle: .footnote)
        hint.adjustsFontForContentSizeCategory = true
        hint.textColor = UIColor(Cockpit.Color.textTertiary); hint.textAlignment = .center
        progress.backgroundColor = UIColor(Cockpit.Color.textTertiary)
        for view in [box, counter, hint, progress] { view.isUserInteractionEnabled = false; addSubview(view) }
        isAccessibilityElement = true
        accessibilityTraits = .allowsDirectInteraction
        accessibilityLabel = "Three-minute reaction test. Touch anywhere when the counter appears."
        calls.setDelegate(self, queue: .main)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func layoutSubviews() {
        super.layoutSubviews()
        box.frame = CGRect(x: (bounds.width - 220) / 2, y: (bounds.height - 96) / 2, width: 220, height: 96)
        counter.frame = box.frame
        hint.frame = CGRect(x: Cockpit.Space.s4, y: bounds.height - safeAreaInsets.bottom - Cockpit.Size.target - Cockpit.Space.s3,
                            width: bounds.width - 2 * Cockpit.Space.s4, height: Cockpit.Size.target)
    }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard let window else { stop(); return }
        guard session.record == nil, link == nil else { return }
        session.start(clock: CACurrentMediaTime(), date: AppClock.now, device: .object([
            "model": .string(HardwareIdentity.machineModel), "os": .string(HardwareIdentity.osVersion),
            "refresh_hz": .integer(Int64(window.screen.maximumFramesPerSecond)),
            "low_power": .bool(ProcessInfo.processInfo.isLowPowerModeEnabled)]))
        let link = CADisplayLink(target: self, selector: #selector(drawFrame(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: Float(window.screen.maximumFramesPerSecond), preferred: Float(window.screen.maximumFramesPerSecond))
        self.link = link; link.add(to: .main, forMode: .common)
    }
    @objc private func drawFrame(_ link: CADisplayLink) {
        let frame = session.frame(targetTimestamp: link.targetTimestamp, frameDuration: max(1 / 240, link.targetTimestamp - link.timestamp))
        CATransaction.begin(); CATransaction.setDisableActions(true)
        counter.text = frame.counter
        counter.textColor = frame.feedback ? feedbackInk : ink
        box.layer.borderColor = (frame.feedback ? feedbackInk : edge).resolvedColor(with: traitCollection).cgColor
        hint.text = frame.hint
        progress.frame = CGRect(x: 0, y: safeAreaInsets.top, width: bounds.width * frame.progress, height: Cockpit.Stroke.line)
        CATransaction.commit()
        if session.record != nil { stop() }
    }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.min(by: { $0.timestamp < $1.timestamp }) else { return }
        session.touch(timestamp: touch.timestamp)
    }
    nonisolated func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
        let active = !call.hasEnded
        let clock = CACurrentMediaTime()
        Task { @MainActor [weak self] in
            if active { self?.session.interrupt("call", clock: clock) }
        }
    }
    func stop() { link?.invalidate(); link = nil }
}

@MainActor
private final class CheckInSaveLease {
    private var identifier: UIBackgroundTaskIdentifier = .invalid
    init() {
        identifier = UIApplication.shared.beginBackgroundTask(withName: "Check-in save") { [weak self] in
            self?.end()
        }
    }
    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}
