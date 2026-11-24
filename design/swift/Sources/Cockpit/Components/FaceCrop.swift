import SwiftUI

public struct FaceCrop: View {
    public enum Mode: Sendable { case open, out, choose }

    let photo: Image?
    let label: String
    let mode: Mode
    let on: Bool
    let action: (() -> Void)?
    var forced: RowHighlight?
    var focused = false

    public init(_ photo: Image?, label: String, mode: Mode = .open, on: Bool = false, action: (() -> Void)? = nil) {
        self.photo = photo
        self.label = label
        self.mode = mode
        self.on = on
        self.action = action
    }

    public var body: some View {
        if let action {
            Button(action: action) { EmptyView() }
                .buttonStyle(FaceCropStyle(crop: self))
                .accessibilityLabel(label)
                .accessibilityValue(value)
                .accessibilityAddTraits(on && mode != .out ? .isSelected : [])
        } else {
            FaceSquare(crop: self, highlight: nil, hovering: false)
                .accessibilityElement()
                .accessibilityLabel(label)
                .accessibilityAddTraits(.isImage)
        }
    }

    private var value: String {
        switch mode {
        case .open: ""
        case .out: on ? "Moved out" : ""
        case .choose: on ? "Their photo" : ""
        }
    }
}

private struct FaceCropStyle: ButtonStyle {
    let crop: FaceCrop

    func makeBody(configuration: Configuration) -> some View {
        Pressable(crop: crop, pressed: configuration.isPressed)
    }

    private struct Pressable: View {
        let crop: FaceCrop
        let pressed: Bool
        @State private var hovering = false
        @Environment(\.cockpitPlatform) private var platform

        var body: some View {
            let live: RowHighlight? = pressed ? .pressed : hovering && platform == .mac ? .hover : nil
            FaceSquare(crop: crop, highlight: crop.forced ?? live, hovering: hovering || crop.forced == .hover)
                .overlay { FocusRing(radius: Cockpit.Radius.sm, forced: crop.focused) }
                .onHover { hovering = $0 }
        }
    }
}

private struct FaceSquare: View {
    let crop: FaceCrop
    let highlight: RowHighlight?
    let hovering: Bool
    @Environment(\.isEnabled) private var enabled
    @Environment(\.isFocused) private var focused
    @Environment(\.redactionReasons) private var redaction
    @Environment(\.skeletonTone) private var tone
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Cockpit.Radius.sm, style: .continuous)
        if redaction.skeleton {
            shape.fill(tone).aspectRatio(1, contentMode: .fit)
        } else {
            let out = crop.mode == .out && crop.on
            shape.fill(Cockpit.Color.raised)
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    if let photo = crop.photo {
                        photo
                            .resizable()
                            .scaledToFill()
                            .opacity(out ? Cockpit.Opacity.disabled : 1)
                            .grayscale(out ? 1 : 0)
                    } else {
                        Icon(.person, size: .md).foregroundStyle(Cockpit.Color.textTertiary)
                    }
                }
                .clipShape(shape)
                .overlay {
                    shape.strokeBorder(Cockpit.Color.rule, lineWidth: Cockpit.Stroke.border)
                    if let highlight { shape.fill(RowChrome<EmptyView>.color(highlight)) }
                }
                .overlay(alignment: .topTrailing) { mark.padding(6) }
                .opacity(enabled ? 1 : Cockpit.Opacity.disabled)
                .animation(reduceMotion ? nil : .easeOut(duration: Cockpit.Duration.instant), value: crop.on)
        }
    }

    @ViewBuilder private var mark: some View {
        switch crop.mode {
        case .open: EmptyView()
        case .out:
            ZStack {
                Circle().fill(Cockpit.Color.photoScrim)
                Circle().strokeBorder(Cockpit.Color.knob, lineWidth: 1.5)
                Icon(.close, size: .xs).foregroundStyle(Cockpit.Color.knob)
            }
            .frame(width: 20, height: 20)
            .opacity(crop.on || hovering || focused || crop.focused ? 1 : 0)
        case .choose: if crop.on { Tick(on: true, photo: true) }
        }
    }
}
