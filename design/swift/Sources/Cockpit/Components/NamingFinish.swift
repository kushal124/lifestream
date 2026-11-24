import SwiftUI

public struct NamingFinish<Map: View>: View {
    let count: Int
    let line: String
    let named: [NamedPlace]
    let done: () -> Void
    let added: NamingAdded?
    let map: Map

    static var mark: CGFloat { 44 }
    static var halo: CGFloat { 8 }

    public init(count: Int, line: String, named: [NamedPlace], added: NamingAdded? = nil, done: @escaping () -> Void,
                @ViewBuilder map: () -> Map) {
        self.count = count
        self.line = line
        self.named = named
        self.added = added
        self.done = done
        self.map = map()
    }

    public var body: some View {
        let shown = Array(named.prefix(3))
        GeometryReader { screen in
            let mapHeight = min(360, max(220, (screen.size.height + screen.safeAreaInsets.top) * 0.4))
            VStack(spacing: 0) {
                ScrollView {
                    VStack(spacing: 0) {
                        map
                            .frame(height: mapHeight)
                            .frame(maxWidth: .infinity)
                            .clipped()
                            .overlay(alignment: .bottom) { mark.offset(y: Self.mark / 2 + Self.halo) }
                        VStack(spacing: Cockpit.Space.s1) {
                            Text("\(count) \(count == 1 ? "place" : "places") named")
                                .cockpit(.title1)
                                .foregroundStyle(Cockpit.Color.text)
                                .multilineTextAlignment(.center)
                                .accessibilityAddTraits(.isHeader)
                                .accessibilityIdentifier("naming.finish")
                            Text(line)
                                .cockpit(.subhead)
                                .foregroundStyle(Cockpit.Color.textSecondary)
                                .multilineTextAlignment(.center)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.horizontal, Cockpit.Space.s5)
                        .padding(.top, Self.mark / 2 + Self.halo + Cockpit.Space.s4)
                        VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                            if !shown.isEmpty {
                                Card(group: true) {
                                    ForEach(shown) { place in
                                        NamedRow(place: place, separator: place != shown.last)
                                    }
                                }
                            }
                            if count > shown.count {
                                Text("and \(count - shown.count) more, now in your places")
                                    .cockpit(.subhead)
                                    .foregroundStyle(Cockpit.Color.textSecondary)
                                    .padding(.horizontal, Cockpit.Space.s4)
                            }
                        }
                        .padding(.horizontal, Cockpit.Space.s5)
                        .padding(.top, Cockpit.Space.s6)
                        .padding(.bottom, Cockpit.Space.s6)
                    }
                }
                .scrollBounceBehavior(.basedOnSize)
                .ignoresSafeArea(.container, edges: .top)
                VStack(spacing: Cockpit.Space.s2) {
                    if let added {
                        NamingAddedRow(added)
                    }
                    Button("Done", action: done)
                        .buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
                        .accessibilityIdentifier("naming.done")
                }
                .padding(.horizontal, Cockpit.Space.s5)
                .padding(.top, Cockpit.Space.s3)
                .padding(.bottom, Cockpit.Space.s2)
                .groundColor(Cockpit.Color.canvas)
            }
        }
        .groundColor(Cockpit.Color.canvas)
    }

    private var mark: some View {
        ZStack {
            Circle().fill(Cockpit.Color.here.opacity(0.22))
            Circle().fill(Cockpit.Color.here)
                .overlay(Circle().strokeBorder(Cockpit.Color.canvas, lineWidth: 2))
                .frame(width: Self.mark, height: Self.mark)
            Icon(.done, size: .lg)
                .foregroundStyle(Cockpit.Color.onSignal)
        }
        .frame(width: Self.mark + Self.halo * 2, height: Self.mark + Self.halo * 2)
        .accessibilityHidden(true)
    }
}

public struct NamedPlace: Identifiable, Hashable {
    public let id: String
    public let name: String
    public let day: String

    public init(id: String, name: String, day: String) {
        self.id = id
        self.name = name
        self.day = day
    }
}

private struct NamedRow: View {
    let place: NamedPlace
    let separator: Bool
    @Environment(\.cockpitPlatform) private var platform

    var body: some View {
        HStack(spacing: Cockpit.Space.s3) {
            ZStack {
                Circle().fill(Cockpit.Color.here.opacity(0.22)).frame(width: 16, height: 16)
                Circle().fill(Cockpit.Color.here).frame(width: 8, height: 8)
            }
            .accessibilityHidden(true)
            Text(place.name)
                .cockpit(.rowTitle)
                .foregroundStyle(Cockpit.Color.text)
                .cockpitLines(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(place.day)
                .cockpit(.monoData)
                .foregroundStyle(Cockpit.Color.textSecondary)
        }
        .padding(.horizontal, platform.rowInset)
        .frame(minHeight: platform.rowHeight)
        .overlay(alignment: .bottom) {
            if separator {
                Rectangle().fill(Cockpit.Color.rule).frame(height: Cockpit.pixelRule).padding(.leading, platform.rowInset)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
