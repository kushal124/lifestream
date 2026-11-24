import Cockpit
import SwiftUI
import UIKit

struct VoiceNotePanel: View {
    @ObservedObject var controller: VoiceRecordController
    private var saving: Bool {
        if case .saving = controller.phase { true } else { false }
    }

    private var starting: Bool { controller.phase == .starting }

    private var elapsed: TimeInterval {
        switch controller.phase {
        case .recording(let elapsed, _), .saving(let elapsed): elapsed
        case .idle, .asking, .starting, .denied, .failed: 0
        }
    }

    private var levels: [Float] {
        if case .recording(_, let levels) = controller.phase { levels } else { VoiceRecordController.silence }
    }

    @ViewBuilder var body: some View {
        switch controller.phase {
        case .denied:
            said(InPlaceLine("The microphone is off for Lifestream. Voice notes need it.", act: "Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            })
        case .failed(let message):
            said(InPlaceLine(message) { controller.again() })
        case .idle, .asking, .starting, .recording, .saving:
            recording
        }
    }

    private func said(_ line: InPlaceLine) -> some View {
        Drawer("Voice note", close: { controller.acknowledge() }) {
            line.accessibilityIdentifier("voice.said")
        } foot: {
            Button("Close") { controller.acknowledge() }
                .buttonStyle(.cockpit(.secondary, size: .large, fullWidth: true))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voice.panel")
        .drawerRest()
    }

    private var recording: some View {
        Drawer(saving ? "Saving" : "Recording", close: { controller.cancel() }) {
            VStack(alignment: .center, spacing: Cockpit.Gap.row) {
                Text(Self.clock(elapsed))
                    .cockpit(.figureL)
                    .foregroundStyle(Cockpit.Color.text)
                LevelBars(levels: levels)
                    .frame(height: Cockpit.Space.s8)
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(saving
                ? "Saving voice note"
                : "Recording, \(Self.clock(elapsed))")
            .accessibilityIdentifier("voice.clock")
        } foot: {
            HStack(spacing: Cockpit.Gap.row) {
                Button("Cancel", role: .cancel) { controller.cancel() }
                    .buttonStyle(.cockpit(.secondary, size: .large, fullWidth: true))
                    .disabled(saving)
                    .accessibilityHint("Discards the recording.")
                    .accessibilityIdentifier("voice.cancel")
                Button("Stop") { controller.stop() }
                    .buttonStyle(.cockpit(.primary, size: .large, busy: saving, fullWidth: true))
                    .disabled(starting)
                    .accessibilityHint("Saves the voice note.")
                    .accessibilityIdentifier("voice.stop")
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(saving ? "voice.saving" : "voice.actions")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("voice.panel")
        .accessibilityAction(.escape) { controller.cancel() }
        .drawerRest()
        .interactiveDismissDisabled()
    }

    static func clock(_ seconds: TimeInterval) -> String {
        let whole = Int(seconds.rounded(.down))
        return String(format: "%d:%02d", whole / 60, whole % 60)
    }
}

struct LevelBars: View {
    let levels: [Float]

    var body: some View {
        GeometryReader { geometry in
            let bars = max(1, Int(geometry.size.width / 5))
            HStack(alignment: .center, spacing: 2) {
                ForEach(0..<bars, id: \.self) { bar in
                    let level = levels.isEmpty ? 0 : levels[bar * levels.count / bars]
                    Capsule()
                        .fill(Cockpit.Color.textSecondary)
                        .frame(width: 3, height: max(3, CGFloat(level) * geometry.size.height))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .animation(.linear(duration: 0.05), value: levels)
        .accessibilityHidden(true)
    }
}
