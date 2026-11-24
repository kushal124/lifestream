import CoreGraphics
import SwiftUI

public struct MoveAndScale: View {
    public struct Square: Equatable, Sendable {
        public let x: Int
        public let y: Int
        public let side: Int

        public init(x: Int, y: Int, side: Int) {
            self.x = x
            self.y = y
            self.side = side
        }
    }

    let picture: CGImage
    let drawnDown: Double
    let cancel: () -> Void
    let use: (Square) -> Void
    @State private var square: Frame
    @State private var dragged: CGSize?
    @State private var pinched: CGFloat?
    @Environment(\.cockpitPlatform) private var platform

    public init(_ picture: CGImage, drawnDown: Double = 1, start: Square? = nil, cancel: @escaping () -> Void,
                use: @escaping (Square) -> Void) {
        self.picture = picture
        self.drawnDown = drawnDown
        self.cancel = cancel
        self.use = use
        let bounds = Bounds(width: Double(picture.width), height: Double(picture.height), drawnDown: drawnDown)
        _square = State(initialValue: start.map { bounds.held(Frame(x: Double($0.x), y: Double($0.y), side: Double($0.side))) }
            ?? bounds.whole)
    }

    private var bounds: Bounds { Bounds(width: Double(picture.width), height: Double(picture.height), drawnDown: drawnDown) }

    public var body: some View {
        if platform == .ios {
            ZStack {
                stage.ignoresSafeArea()
                VStack(spacing: 0) {
                    Text("Move and Scale")
                        .cockpit(.headline)
                        .foregroundStyle(Cockpit.Color.text)
                        .frame(minHeight: Cockpit.Size.target)
                        .accessibilityAddTraits(.isHeader)
                    Spacer()
                    HStack {
                        Button("Cancel", action: cancel).buttonStyle(.cockpit(.secondary))
                        Spacer()
                        Button("Choose") { use(bounds.answer(square)) }.buttonStyle(.cockpit(.primary))
                    }
                    .padding(.horizontal, platform.margin)
                    .padding(.bottom, Cockpit.Space.s4)
                }
            }
            .groundColor(Cockpit.Color.canvas)
            .environment(\.colorScheme, .dark)
        } else {
            VStack(alignment: .trailing, spacing: Cockpit.Space.s4) {
                stage
                    .aspectRatio(1, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.sm, style: .continuous))
                slider
                    .opacity(bounds.least < bounds.most ? 1 : 0)
                    .accessibilityHidden(bounds.least == bounds.most)
                HStack(spacing: Cockpit.Space.s2) {
                    Button("Cancel", action: cancel)
                        .buttonStyle(.cockpit(.secondary, key: "Esc"))
                        .keyboardShortcut(.cancelAction)
                    Button("Use") { use(bounds.answer(square)) }
                        .buttonStyle(.cockpit(.primary, key: "⏎"))
                        .keyboardShortcut(.defaultAction)
                }
            }
            .frame(maxWidth: 600)
        }
    }

    private var stage: some View {
        GeometryReader { geometry in
            let room = geometry.size
            let points = min(room.width, room.height)
            let kept = CGRect(x: (room.width - points) / 2, y: (room.height - points) / 2, width: points, height: points)
            let scale = points / square.side
            (platform == .ios ? Cockpit.Color.canvas : Cockpit.Color.raised)
                .frame(width: room.width, height: room.height)
                .overlay(alignment: .topLeading) {
                    Image(decorative: picture, scale: 1)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: Double(picture.width) * scale, height: Double(picture.height) * scale)
                        .offset(x: kept.minX - square.x * scale, y: kept.minY - square.y * scale)
                }
                .clipped()
                .overlay {
                    Path { path in
                        path.addRect(CGRect(origin: .zero, size: room))
                        path.addEllipse(in: kept)
                    }
                    .fill(Cockpit.Color.photoScrim, style: FillStyle(eoFill: true))
                }
                .overlay(alignment: .topLeading) {
                    Circle().strokeBorder(Cockpit.Color.knob, lineWidth: Cockpit.Stroke.hairline)
                        .frame(width: points, height: points)
                        .offset(x: kept.minX, y: kept.minY)
                }
                .contentShape(Rectangle())
                .gesture(moving(points: points).simultaneously(with: pinching(kept: kept)))
        }
        .accessibilityElement()
        .accessibilityLabel("Picture")
        .accessibilityValue(scaleWords)
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: step(1)
            case .decrement: step(-1)
            @unknown default: break
            }
        }
    }

    private func moving(points: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { drag in
                let before = dragged ?? .zero
                dragged = drag.translation
                let per = square.side / points
                square = bounds.held(Frame(x: square.x - (drag.translation.width - before.width) * per,
                                           y: square.y - (drag.translation.height - before.height) * per, side: square.side))
            }
            .onEnded { _ in dragged = nil }
    }

    private func pinching(kept: CGRect) -> some Gesture {
        MagnifyGesture()
            .onChanged { pinch in
                let before = pinched ?? 1
                pinched = pinch.magnification
                guard pinch.magnification > 0 else { return }
                let at = CGPoint(x: (pinch.startLocation.x - kept.minX) / kept.width, y: (pinch.startLocation.y - kept.minY) / kept.height)
                square = bounds.scaled(square, to: square.side * before / pinch.magnification, about: at)
            }
            .onEnded { _ in pinched = nil }
    }

    private var slider: some View {
        HStack(spacing: Cockpit.Space.s3) {
            Icon(.photo, size: .sm)
            GeometryReader { geometry in
                let knob: CGFloat = 18
                let track = geometry.size.width - knob
                ZStack(alignment: .leading) {
                    Capsule().fill(Cockpit.Color.strokeControl).frame(height: Cockpit.Stroke.line)
                    Circle().fill(Cockpit.Color.knob)
                        .frame(width: knob, height: knob)
                        .cockpitShadow(Cockpit.Shadow.knob, in: Circle())
                        .offset(x: track * bounds.along(square.side))
                }
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0).onChanged { drag in
                    let t = (drag.location.x - knob / 2) / max(1, track)
                    square = bounds.scaled(square, to: bounds.side(at: t), about: CGPoint(x: 0.5, y: 0.5))
                })
            }
            Icon(.photo, size: .lg)
        }
        .foregroundStyle(Cockpit.Color.textTertiary)
        .frame(height: Cockpit.Size.controlMac)
    }

    private func step(_ notches: Double) {
        square = bounds.scaled(square, to: bounds.side(at: bounds.along(square.side) + notches / Bounds.notches),
                               about: CGPoint(x: 0.5, y: 0.5))
    }

    private var scaleWords: String {
        "\((bounds.most / square.side).formatted(.number.precision(.fractionLength(1))))×"
    }
}

extension MoveAndScale {
    struct Frame: Equatable {
        var x: Double
        var y: Double
        var side: Double
    }

    struct Bounds {
        static let least: Double = 160
        static let notches: Double = 12

        let width: Double
        let height: Double
        var drawnDown: Double = 1

        var most: Double { min(width, height) }
        var least: Double { min(Self.least * drawnDown, most) }

        var whole: Frame { Frame(x: (width - most) / 2, y: (height - most) / 2, side: most) }

        func held(_ square: Frame) -> Frame {
            let side = min(most, max(least, square.side))
            let x = square.x + (square.side - side) / 2, y = square.y + (square.side - side) / 2
            return Frame(x: min(width - side, max(0, x)), y: min(height - side, max(0, y)), side: side)
        }

        func scaled(_ square: Frame, to side: Double, about at: CGPoint) -> Frame {
            let kept = min(most, max(least, side))
            return held(Frame(x: square.x + at.x * (square.side - kept), y: square.y + at.y * (square.side - kept), side: kept))
        }

        func along(_ side: Double) -> Double {
            least == most ? 0 : log(most / side) / log(most / least)
        }

        func side(at t: Double) -> Double {
            most * pow(least / most, min(1, max(0, t)))
        }

        func answer(_ square: Frame) -> Square {
            let side = square.side.rounded()
            return Square(x: Int(min(width - side, max(0, square.x.rounded()))),
                          y: Int(min(height - side, max(0, square.y.rounded()))), side: Int(side))
        }
    }
}
