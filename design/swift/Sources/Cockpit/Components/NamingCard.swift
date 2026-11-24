import SwiftUI

public extension Cockpit {
    static let namingCircleAside: CGFloat = 95
}

public struct NamingCard<Page: View>: View {
    let position: Int
    let total: Int
    let close: () -> Void
    let page: Page

    public init(position: Int, of total: Int, close: @escaping () -> Void, @ViewBuilder page: () -> Page) {
        self.position = position
        self.total = total
        self.close = close
        self.page = page()
    }

    public var body: some View {
        VStack(spacing: 0) {
            bar
            page
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .clipped()
                .padding(.top, Cockpit.Space.s3)
        }
        .groundColor(Cockpit.Color.canvas)
    }

    private var bar: some View {
        ZStack {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("Name this place")
                    .cockpit(.headline)
                    .foregroundStyle(Cockpit.Color.text)
                Text("\(position) of \(total)")
                    .cockpit(.monoData)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .contentTransition(.numericText(value: Double(position)))
            }
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .padding(.horizontal, Cockpit.Size.target + Cockpit.Space.s2)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Name this place, \(position) of \(total)")
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("naming.position")
            HStack {
                IconButton(.close, label: "Close", style: .glass, action: close)
                    .accessibilityIdentifier("naming.close")
                Spacer()
            }
        }
        .frame(minHeight: Cockpit.Size.target)
        .padding(.horizontal, Cockpit.Space.s4)
    }
}

public extension View {
    func circleReach<Reach: View>(@ViewBuilder _ reach: () -> Reach) -> some View {
        overlay(alignment: .bottomTrailing) { CircleReachGlass(reach: reach()) }
    }
}

private struct CircleReachGlass<Reach: View>: View {
    let reach: Reach
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if !typeSize.isAccessibilitySize {
            reach
                .padding(.leading, Cockpit.Space.s3)
                .padding(.trailing, Cockpit.Space.s1)
                .padding(.vertical, Cockpit.Space.s1)
                .cockpitGlass(in: Capsule())
                .padding(Cockpit.Space.s3)
        }
    }
}

public struct NamingPage<Map: View, Reach: View, Photos: View, Names: View>: View {
    let witnessed: String
    let last: String?
    @Environment(\.cockpitPlatform) private var platform
    let more: Int
    let takes: String?
    let skip: (() -> Void)?
    let hide: () -> Void
    let note: String?
    let added: NamingAdded?
    let map: Map
    let reach: Reach
    let photos: Photos
    let names: Names
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var photosTop: CGFloat?
    @State private var standing: CGFloat = 0

    public static var mapHeight: CGFloat { 180 }

    public init(witnessed: String, last: String? = nil, more: Int = 0, takes: String? = nil, skip: (() -> Void)?,
                hide: @escaping () -> Void, note: String? = nil, added: NamingAdded? = nil, @ViewBuilder map: () -> Map,
                @ViewBuilder reach: () -> Reach, @ViewBuilder photos: () -> Photos, @ViewBuilder names: () -> Names) {
        self.witnessed = witnessed
        self.last = last
        self.more = more
        self.takes = takes
        self.skip = skip
        self.hide = hide
        self.note = note
        self.added = added
        self.map = map()
        self.reach = reach()
        self.photos = photos()
        self.names = names()
    }

    public var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    map
                        .frame(height: Self.mapHeight)
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous))
                        .circleReach { reach }
                        .padding(.horizontal, Cockpit.Gap.edge)
                    VStack(alignment: .leading, spacing: Cockpit.Space.s4) {
                        if typeSize.isAccessibilitySize { reach }
                        names
                        VStack(alignment: .leading, spacing: 2) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(witnessed)
                                    .cockpit(.subhead)
                                    .foregroundStyle(Cockpit.Color.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                                if let last {
                                    Text(last)
                                        .cockpit(.subhead)
                                        .monospacedDigit()
                                        .foregroundStyle(Cockpit.Color.textSecondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                            }
                            .accessibilityElement(children: .combine)
                            .accessibilityIdentifier("naming.witnessed")
                            if let takes {
                                Text(takes)
                                    .cockpit(.subhead)
                                    .foregroundStyle(Cockpit.Color.textSecondary)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .accessibilityIdentifier("naming.takes")
                            }
                        }
                        .padding(.top, Cockpit.Space.s1)
                        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                            photos.environment(\.cockpitPhotosRoom, room)
                            if more > 0 {
                                Text("+ \(more) more")
                                    .cockpit(.footnote)
                                    .foregroundStyle(Cockpit.Color.textTertiary)
                                    .accessibilityIdentifier("naming.more")
                            }
                        }
                        .onGeometryChange(for: CGFloat.self) { $0.frame(in: .named(Self.column)).minY } action: { photosTop = $0 }
                    }
                    .padding(.horizontal, Cockpit.Space.s5)
                    .padding(.top, Cockpit.Space.s4)
                    .padding(.bottom, Cockpit.Space.s5)
                    .contentShape(Rectangle())
                    .simultaneousGesture(swipe)
                }
                .coordinateSpace(.named(Self.column))
            }
            .scrollBounceBehavior(.basedOnSize)
            .overlay(alignment: .bottom) {
                LinearGradient(colors: [Cockpit.Color.canvas.opacity(0), Cockpit.Color.canvas], startPoint: .top, endPoint: .bottom)
                    .frame(height: Self.footFade)
                    .allowsHitTesting(false)
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { standing = max(standing, $0) }
            foot
        }
    }

    private static var footFade: CGFloat { 16 }

    private static var column: String { "naming.column" }

    private var room: PhotosRoom? {
        guard let photosTop, standing > 0 else { return nil }
        return PhotosRoom(height: standing - photosTop - Self.footFade, under: Self.footFade, followed: more > 0)
    }

    private var swipe: some Gesture {
        DragGesture(minimumDistance: 24).onEnded { drag in
            if let skip, drag.translation.width < -80, abs(drag.translation.width) > abs(drag.translation.height) * 1.5 { skip() }
        }
    }

    private var foot: some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
            if let added {
                NamingAddedRow(added)
            }
            acts
            if let note {
                Text(note)
                    .cockpit(.footnote)
                    .foregroundStyle(Cockpit.Color.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("naming.note")
            }
        }
        .padding(.horizontal, Cockpit.Space.s5)
        .padding(.top, Cockpit.Space.s2)
        .padding(.bottom, Cockpit.Space.s2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .groundColor(Cockpit.Color.canvas)
    }

    @ViewBuilder private func skipButton(_ skip: @escaping () -> Void) -> some View {
        if platform == .ios {
            Button(action: skip) {
                Text("Skip")
                    .cockpit(Cockpit.Style.iosBody)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .frame(minHeight: Cockpit.Size.controlMd)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        } else {
            Button("Skip", action: skip).buttonStyle(.cockpit(.secondary))
        }
    }

    private var acts: some View {
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: Cockpit.Space.s1))
            : AnyLayout(HStackLayout(spacing: Cockpit.Space.s3))
        return layout {
            if let skip {
                skipButton(skip)
                .accessibilityLabel("Skip")
                .accessibilityIdentifier("naming.skip")
            }
            if !stacked { Spacer(minLength: 0) }
            Button(action: hide) {
                Group {
                    if platform == .ios {
                        Text("Hide this place").cockpit(Cockpit.Style.iosBody).foregroundStyle(Cockpit.Color.textSecondary)
                    } else {
                        Text("Hide this place").cockpit(.subhead).foregroundStyle(Cockpit.Color.textTertiary)
                    }
                }
                .frame(minHeight: Cockpit.Size.controlMd)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("naming.hide")
        }
    }
}

public struct NamingAdded {
    let words: String
    let undo: () -> Void

    public init(_ words: String, undo: @escaping () -> Void) {
        self.words = words
        self.undo = undo
    }
}

struct NamingAddedRow: View {
    let added: NamingAdded

    init(_ added: NamingAdded) {
        self.added = added
    }

    var body: some View {
        HStack(spacing: Cockpit.Space.s3) {
            Text(added.words)
                .cockpit(.subhead)
                .foregroundStyle(Cockpit.Color.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("naming.added")
            Button(action: added.undo) {
                Text("Undo")
                    .cockpit(.subhead)
                    .fontWeight(.medium)
                    .foregroundStyle(Cockpit.Color.text)
                    .frame(minHeight: Cockpit.Size.target)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("naming.undo")
        }
        .transition(.opacity)
    }
}
