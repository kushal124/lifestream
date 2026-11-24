import SwiftUI

public enum VideoClock {
    public static func words(_ seconds: Double) -> String {
        let whole = Int(max(0, seconds.isFinite ? seconds : 0))
        let (hours, minutes, rest) = (whole / 3600, whole / 60 % 60, whole % 60)
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
    }

    public static func length(_ seconds: Double) -> String {
        words(seconds > 0 ? max(1, seconds.rounded()) : 0)
    }

    public static func left(_ elapsed: Double, of length: Double) -> String {
        "\u{2212}" + words(max(0, length.rounded() - elapsed.rounded(.down)))
    }

    static func slot(_ length: Double) -> String {
        String(words(max(length, 0)).map { $0.isNumber ? "0" : $0 })
    }
}

public struct VideoBar: View {
    public enum State: Equatable, Sendable {
        case paused, playing, waiting
        case said(String)
    }

    let state: State
    let elapsed: Double
    let length: Double?
    let muted: Bool
    let toggle: () -> Void
    let seek: (_ seconds: Double, _ done: Bool) -> Void
    let mute: () -> Void
    @SwiftUI.State private var held: Double?
    var forcedHeld: Double?

    public init(state: State, elapsed: Double, length: Double?, muted: Bool, toggle: @escaping () -> Void,
                seek: @escaping (_ seconds: Double, _ done: Bool) -> Void, mute: @escaping () -> Void) {
        self.state = state
        self.elapsed = elapsed
        self.length = length
        self.muted = muted
        self.toggle = toggle
        self.seek = seek
        self.mute = mute
    }

    public var body: some View {
        Group {
            if case .said(let words) = state {
                Text(words)
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, Cockpit.Space.s5)
                    .frame(maxWidth: .infinity, minHeight: Cockpit.Size.controlMd)
                    .accessibilityIdentifier("viewer.video.said")
            } else {
                controls
            }
        }
        .cockpitGlass(in: Capsule())
        .contentShape(Capsule())
        .gesture(DragGesture(minimumDistance: 0))
        .padding(.horizontal, Cockpit.Space.s4)
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("viewer.video.bar")
    }

    private var controls: some View {
        let shown = (held ?? forcedHeld).map { $0 * (length ?? 0) } ?? elapsed
        return HStack(spacing: 0) {
            Button(action: toggle) {
                Group {
                    if state == .waiting {
                        Spinner()
                    } else {
                        Icon(state == .playing ? .pause : .play, weight: .fill, size: .md)
                    }
                }
                .foregroundStyle(Cockpit.Color.text)
                .frame(width: Cockpit.Size.controlMd, height: Cockpit.Size.controlMd)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(state == .playing ? "Pause" : "Play")
            .accessibilityIdentifier("viewer.video.play")
            if let length {
                time(VideoClock.words(shown), slot: VideoClock.slot(length), color: Cockpit.Color.text)
                    .padding(.trailing, Cockpit.Space.s3)
                scrubber(shown / max(length, 0.001), length: length)
                time(VideoClock.left(shown, of: length), slot: "\u{2212}" + VideoClock.slot(length), color: Cockpit.Color.textSecondary)
                    .padding(.leading, Cockpit.Space.s3)
            } else {
                scrubber(0, length: nil)
            }
            Button(action: mute) {
                Icon(muted ? .muted : .sound, size: .md)
                    .foregroundStyle(Cockpit.Color.text)
                    .frame(width: Cockpit.Size.controlMd, height: Cockpit.Size.controlMd)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(muted ? "Unmute" : "Mute")
            .accessibilityIdentifier("viewer.video.mute")
        }
        .frame(height: Cockpit.Size.controlMd)
    }

    private func time(_ words: String, slot: String, color: Color) -> some View {
        ZStack(alignment: .trailing) {
            Text(slot).hidden()
            Text(words).foregroundStyle(color)
        }
        .cockpit(.monoData)
        .monospacedDigit()
        .lineLimit(1)
        .fixedSize()
        .accessibilityHidden(true)
    }

    private func scrubber(_ fraction: Double, length: Double?) -> some View {
        let holding = held != nil || forcedHeld != nil
        let thick: CGFloat = holding ? 8 : 4
        return GeometryReader { box in
            ZStack(alignment: .leading) {
                Capsule().fill(Cockpit.Color.data3)
                Capsule().fill(Cockpit.Color.text)
                    .frame(width: max(thick, box.size.width * min(max(fraction, 0), 1)))
                    .opacity(length == nil ? 0 : 1)
            }
            .frame(height: thick)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0)
                .onChanged { drag in
                    guard let length else { return }
                    let at = min(max(drag.location.x / max(box.size.width, 1), 0), 1)
                    held = at
                    seek(at * length, false)
                }
                .onEnded { drag in
                    guard let length else { return }
                    let at = min(max(drag.location.x / max(box.size.width, 1), 0), 1)
                    held = nil
                    seek(at * length, true)
                })
        }
        .animation(.easeOut(duration: Cockpit.Duration.instant), value: holding)
        .frame(maxWidth: .infinity)
        .accessibilityElement()
        .accessibilityLabel("Place")
        .accessibilityValue(length.map { "\(VideoClock.words(elapsed)) of \(VideoClock.length($0))" } ?? "")
        .accessibilityAdjustableAction { direction in
            guard let length else { return }
            let step = direction == .increment ? 10.0 : -10.0
            seek(min(max(elapsed + step, 0), length), true)
        }
        .accessibilityIdentifier("viewer.video.scrubber")
    }
}

public struct VideoMark: View {
    let length: Double?

    public init(length: Double?) {
        self.length = length
    }

    public var body: some View {
        HStack(spacing: 3) {
            Icon(.play, weight: .fill, size: .xs)
            if let length {
                Text(VideoClock.length(length)).cockpit(.caption2).monospacedDigit()
            }
        }
        .foregroundStyle(Cockpit.Color.text)
        .padding(.leading, length == nil ? 4 : 5)
        .padding(.trailing, length == nil ? 4 : 6)
        .frame(minHeight: 20)
        .background(Capsule().fill(Cockpit.Color.photoScrim))
        .environment(\.colorScheme, .dark)
        .padding(Cockpit.Space.s1)
        .accessibilityHidden(true)
    }
}
