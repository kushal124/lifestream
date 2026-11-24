import SwiftUI

public struct PhotoFacts {
    public enum Link: Hashable, Sendable {
        case place, moment, chat, sent
        case person(String)
    }

    public struct Person: Identifiable {
        public let id: String
        public let name: String
        public let photo: Image?

        public init(id: String, name: String, photo: Image? = nil) {
            self.id = id
            self.name = name
            self.photo = photo
        }
    }

    public struct Place {
        public let name: String
        public let area: String?

        public init(name: String, area: String?) {
            self.name = name
            self.area = area
        }
    }

    public struct Row {
        public let first: String
        public let second: String?

        public init(_ first: String, _ second: String? = nil) {
            self.first = first
            self.second = second
        }
    }

    public var title: String
    public var titleOpens: Link?
    public var moment: String?
    public var spoken: String
    public var caption: String?
    public var made: Row?
    public var refused: String?
    public var sent: Row?
    public var sentOpens: Bool
    public var people: [Person]
    public var place: Place?
    public var date: Row?
    public var camera: Row?
    public var chat: Row?

    public init(title: String, titleOpens: Link? = nil, moment: String? = nil, spoken: String, caption: String? = nil,
                made: Row? = nil, refused: String? = nil, sent: Row? = nil, sentOpens: Bool = false, people: [Person] = [],
                place: Place? = nil, date: Row? = nil, camera: Row? = nil, chat: Row? = nil) {
        self.title = title
        self.titleOpens = titleOpens
        self.moment = moment
        self.spoken = spoken
        self.caption = caption
        self.made = made
        self.refused = refused
        self.sent = sent
        self.sentOpens = sentOpens
        self.people = people
        self.place = place
        self.date = date
        self.camera = camera
        self.chat = chat
    }
}

public extension PhotoFacts {
    static let seeSent = "See what was sent"
}

public enum PhotoViewerFacts {
    case reading
    case read(PhotoFacts)
    case failed(String)
}

public struct PhotoViewerFrame<Picture: View, Map: View, Act: View, Bar: View>: View {
    public typealias Facts = PhotoViewerFacts

    let facts: Facts
    let layer: Bool
    let info: Bool
    let size: CGSize?
    let ground: Double
    let close: () -> Void
    let toggleInfo: () -> Void
    let lowerInfo: () -> Void
    let open: (PhotoFacts.Link) -> Void
    let picture: Picture
    let map: Map
    let act: Act?
    let bar: Bar
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public static var infoTop: CGFloat { 310 }

    public init(facts: Facts, layer: Bool, info: Bool, size: CGSize?, ground: Double = 1, close: @escaping () -> Void,
                toggleInfo: @escaping () -> Void, lowerInfo: @escaping () -> Void, open: @escaping (PhotoFacts.Link) -> Void,
                @ViewBuilder picture: () -> Picture, @ViewBuilder map: () -> Map, act: Act?, @ViewBuilder bar: () -> Bar) {
        self.facts = facts
        self.layer = layer
        self.info = info
        self.size = size
        self.ground = ground
        self.close = close
        self.toggleInfo = toggleInfo
        self.lowerInfo = lowerInfo
        self.open = open
        self.picture = picture()
        self.map = map()
        self.act = act
        self.bar = bar()
    }

    private static var pull: CGFloat { 60 }
    private static var button: CGFloat { Cockpit.Size.controlMd }
    private static var under: CGFloat { Cockpit.Space.s3 }
    private static var wash: CGFloat { 120 }

    public var body: some View {
        GeometryReader { screen in
            let insets = Self.safe(screen.safeAreaInsets)
            let room = CGSize(width: screen.size.width, height: max(0, screen.size.height - insets.top - insets.bottom))
            let read: PhotoFacts? = if case .read(let facts) = facts { facts } else { nil }
            let shown = layer || voiceOver
            ZStack(alignment: .top) {
                Cockpit.Color.canvas.opacity(ground)
                picture
                    .frame(width: room.width, height: info ? max(0, min(Self.infoTop, screen.size.height) - insets.top) : room.height)
                    .padding(.top, insets.top)
                if shown, !info, reaches(room, band: Self.under + Self.button) {
                    LinearGradient(colors: [Cockpit.Color.photoScrim, .clear], startPoint: .top, endPoint: .bottom)
                        .frame(height: Self.wash)
                        .allowsHitTesting(false)
                        .transition(.opacity)
                }
                if shown || info {
                    top(read: info ? nil : read)
                        .padding(.horizontal, Cockpit.Space.s4)
                        .padding(.top, insets.top + Self.under)
                        .transition(.opacity)
                }
                if shown, !info {
                    VStack(spacing: Cockpit.Space.s3) {
                        bar
                        if let read, !read.people.isEmpty { chips(read.people) }
                    }
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .padding(.bottom, insets.bottom + 14)
                    .transition(.opacity)
                }
                if info {
                    sheet(insets: insets)
                        .padding(.top, Self.infoTop)
                        .transition(reduceMotion ? .opacity : .move(edge: .bottom))
                }
            }
            .frame(width: screen.size.width, height: screen.size.height, alignment: .top)
        }
        .ignoresSafeArea()
        .environment(\.colorScheme, .dark)
    }

    private static func safe(_ read: EdgeInsets) -> EdgeInsets {
        #if os(iOS)
        let window = UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?.safeAreaInsets
        return EdgeInsets(top: max(read.top, window?.top ?? 0), leading: read.leading,
                          bottom: max(read.bottom, window?.bottom ?? 0), trailing: read.trailing)
        #else
        return read
        #endif
    }

    private func reaches(_ screen: CGSize, band: CGFloat) -> Bool {
        guard let size, size.width > 0, size.height > 0 else { return false }
        let drawn = size.height * min(screen.width / size.width, screen.height / size.height)
        return (screen.height - drawn) / 2 < band
    }


    private func top(read: PhotoFacts?) -> some View {
        ZStack {
            HStack {
                IconButton(.close, label: "Close", style: .glass, action: close)
                Spacer(minLength: 0)
                InfoToggle(on: info, action: toggleInfo)
            }
            if let read {
                VStack(spacing: 1) {
                    line(read.title, role: .headline, color: Cockpit.Color.text, opens: read.titleOpens)
                        .accessibilityIdentifier("viewer.title")
                    if let moment = read.moment {
                        line(moment, role: .footnote, color: Cockpit.Color.textSecondary, opens: .moment)
                            .accessibilityIdentifier("viewer.date")
                    }
                }
                .padding(.horizontal, Self.button + Cockpit.Space.s2)
            }
        }
    }

    @ViewBuilder private func line(_ words: String, role: Cockpit.Role, color: Color, opens: PhotoFacts.Link?) -> some View {
        let text = Text(words).cockpit(role).foregroundStyle(color).lineLimit(1).truncationMode(.tail)
        if let opens {
            Button { open(opens) } label: { text }.buttonStyle(.plain)
        } else {
            text
        }
    }


    private func chips(_ people: [PhotoFacts.Person]) -> some View {
        let row = HStack(spacing: Cockpit.Space.s2) {
            ForEach(Array(people.enumerated()), id: \.element.id) { index, person in
                Button { open(.person(person.id)) } label: {
                    HStack(spacing: Cockpit.Space.s2) {
                        PersonFace(person.name, photo: person.photo, size: .chip)
                        Text(person.name).cockpit(.rowTitle).foregroundStyle(Cockpit.Color.text).lineLimit(1).fixedSize()
                    }
                    .padding(.leading, 6)
                    .padding(.trailing, 14)
                    .frame(minHeight: 40)
                    .cockpitGlass(in: Capsule())
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(person.name)
                .accessibilityAddTraits(.isButton)
                .accessibilityIdentifier("viewer.chip.\(index)")
            }
        }
        return ViewThatFits(in: .horizontal) {
            row.padding(.horizontal, Cockpit.Space.s4)
            ScrollView(.horizontal, showsIndicators: false) { row.padding(.horizontal, Cockpit.Space.s4) }
        }
    }


    private func sheet(insets: EdgeInsets) -> some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(Cockpit.Color.track)
                .frame(width: 36, height: 5)
                .padding(.top, Cockpit.Space.s2)
                .frame(maxWidth: .infinity, minHeight: 18, alignment: .top)
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 10).onEnded { drag in
                    if drag.translation.height > Self.pull { lowerInfo() }
                })
                .accessibilityHidden(true)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    switch facts {
                    case .reading:
                        EmptyView()
                    case .failed(let words):
                        InPlaceLine(words)
                            .accessibilityIdentifier("viewer.info.error")
                    case .read(let read):
                        parts(read)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Cockpit.Space.s5)
                .padding(.top, 18)
                .padding(.bottom, insets.bottom + Cockpit.Space.s5)
            }
            .lowersWhenPulled(past: Self.pull, lowerInfo)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(UnevenRoundedRectangle(topLeadingRadius: Cockpit.Radius.s2xl, topTrailingRadius: Cockpit.Radius.s2xl,
                                           style: .continuous).fill(Cockpit.Color.surface))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Info")
        .accessibilityIdentifier("viewer.info")
    }

    @ViewBuilder private func parts(_ read: PhotoFacts) -> some View {
        if let caption = read.caption {
            Text(caption)
                .cockpit(.body)
                .foregroundStyle(Cockpit.Color.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("viewer.info.caption")
        }
        if read.made != nil || act != nil {
            HStack(alignment: .center, spacing: Cockpit.Space.s3) {
                if let made = read.made {
                    row(.ai, made, opens: nil).accessibilityIdentifier("viewer.info.made.line")
                }
                if let act { act }
                if read.made == nil { Spacer(minLength: 0) }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("viewer.info.made")
        }
        if let refused = read.refused {
            InPlaceLine(refused).accessibilityIdentifier("viewer.info.refused")
        }

        if !read.people.isEmpty {
            people(read.people)
        }
        if let place = read.place {
            Button { open(.place) } label: {
                VStack(spacing: 0) {
                    map.frame(height: 104).frame(maxWidth: .infinity).clipped().allowsHitTesting(false)
                    HStack(spacing: Cockpit.Space.s3) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(place.name).cockpit(.rowTitle).foregroundStyle(Cockpit.Color.text)
                            if let area = place.area {
                                Text(area).cockpit(.footnote).foregroundStyle(Cockpit.Color.textSecondary)
                            }
                        }
                        Spacer(minLength: 0)
                        Icon(.forward, size: .sm).foregroundStyle(Cockpit.Color.textTertiary)
                    }
                    .padding(.horizontal, 14)
                    .frame(minHeight: 52)
                }
                .background(Cockpit.Color.raised)
                .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.md, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: Cockpit.Radius.md, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([place.name, place.area].compactMap { $0 }.joined(separator: ", "))
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("viewer.info.place")
        }
        if let date = read.date {
            row(.days, date, opens: .moment).accessibilityIdentifier("viewer.info.date")
        }
        if let camera = read.camera {
            row(.photo, camera, opens: nil).accessibilityIdentifier("viewer.info.camera")
        }
        if let chat = read.chat {
            row(.message, chat, opens: .chat).accessibilityIdentifier("viewer.info.chat")
        }
        if let sent = read.sent {
            row(.send, sent, opens: read.sentOpens ? .sent : nil).accessibilityIdentifier("viewer.info.sent")
        }
    }

    private func people(_ people: [PhotoFacts.Person]) -> some View {
        let row = HStack(alignment: .top, spacing: Cockpit.Space.s5) {
            ForEach(Array(people.enumerated()), id: \.element.id) { index, person in
                Button { open(.person(person.id)) } label: {
                    NameColumn {
                        VStack(spacing: 6) {
                            PersonFace(person.name, photo: person.photo, size: .portrait)
                            Text(person.name)
                                .cockpit(.footnote)
                                .fontWeight(.medium)
                                .foregroundStyle(Cockpit.Color.text)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(person.name)
                .accessibilityAddTraits(.isButton)
                .accessibilityIdentifier("viewer.info.person.\(index)")
            }
        }
        return ViewThatFits(in: .horizontal) {
            row
            ScrollView(.horizontal, showsIndicators: false) { row }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("viewer.info.people")
    }

    @ViewBuilder private func row(_ icon: Cockpit.Icon, _ row: PhotoFacts.Row, opens: PhotoFacts.Link?) -> some View {
        let face = HStack(spacing: Cockpit.Space.s3) {
            Icon(icon, size: .md).foregroundStyle(Cockpit.Color.textTertiary)
            VStack(alignment: .leading, spacing: 1) {
                Text(row.first).cockpit(.subhead).foregroundStyle(Cockpit.Color.text)
                if let second = row.second {
                    Text(second).cockpit(.footnote).foregroundStyle(Cockpit.Color.textSecondary)
                }
            }
            Spacer(minLength: 0)
            if opens != nil {
                Icon(.forward, size: .sm).foregroundStyle(Cockpit.Color.textTertiary)
            }
        }
        .contentShape(Rectangle())
        let said = [row.first, row.second].compactMap { $0 }.joined(separator: ", ")
        if let opens {
            Button { open(opens) } label: { face }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(said)
                .accessibilityAddTraits(.isButton)
        } else {
            face.accessibilityElement(children: .ignore).accessibilityLabel(said)
        }
    }
}

public extension PhotoViewerFrame where Act == EmptyView {
    init(facts: Facts, layer: Bool, info: Bool, size: CGSize?, ground: Double = 1, close: @escaping () -> Void,
         toggleInfo: @escaping () -> Void, lowerInfo: @escaping () -> Void, open: @escaping (PhotoFacts.Link) -> Void,
         @ViewBuilder picture: () -> Picture, @ViewBuilder map: () -> Map, @ViewBuilder bar: () -> Bar) {
        self.init(facts: facts, layer: layer, info: info, size: size, ground: ground, close: close, toggleInfo: toggleInfo,
                  lowerInfo: lowerInfo, open: open, picture: picture, map: map, act: nil, bar: bar)
    }
}

public extension PhotoViewerFrame where Act == EmptyView, Bar == EmptyView {
    init(facts: Facts, layer: Bool, info: Bool, size: CGSize?, ground: Double = 1, close: @escaping () -> Void,
         toggleInfo: @escaping () -> Void, lowerInfo: @escaping () -> Void, open: @escaping (PhotoFacts.Link) -> Void,
         @ViewBuilder picture: () -> Picture, @ViewBuilder map: () -> Map) {
        self.init(facts: facts, layer: layer, info: info, size: size, ground: ground, close: close, toggleInfo: toggleInfo,
                  lowerInfo: lowerInfo, open: open, picture: picture, map: map, act: nil, bar: { EmptyView() })
    }
}

private struct InfoToggle: View {
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) { Icon(.info) }
            .buttonStyle(InfoToggleStyle(on: on))
            .accessibilityLabel("Info")
            .accessibilityAddTraits(on ? .isSelected : [])
            .accessibilityIdentifier("viewer.infoButton")
    }
}

private struct InfoToggleStyle: ButtonStyle {
    let on: Bool

    func makeBody(configuration: Configuration) -> some View {
        let side = Cockpit.Size.controlMd
        configuration.label
            .environment(\.cockpitIconSize, .lg)
            .foregroundStyle(on ? Cockpit.Color.here : Cockpit.Color.text)
            .frame(width: side, height: side)
            .background {
                if on {
                    Circle().fill(Cockpit.Color.hereSoft)
                } else {
                    Circle().fill(configuration.isPressed ? Cockpit.Color.pressed : .clear).cockpitGlass(in: Circle())
                }
            }
            .contentShape(Circle())
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
    }
}

private extension View {
    @ViewBuilder func lowersWhenPulled(past: CGFloat, _ lower: @escaping () -> Void) -> some View {
        if #available(macOS 15, *) {
            onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top < -past
            } action: { _, pulled in
                if pulled { lower() }
            }
        } else {
            self
        }
    }
}

private struct NameColumn: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let size = subviews.first?.sizeThatFits(ProposedViewSize(width: Cockpit.Size.portraitName, height: nil)) ?? .zero
        return CGSize(width: min(max(size.width, Cockpit.Size.avatarPortrait), Cockpit.Size.portraitName), height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: CGPoint(x: bounds.midX, y: bounds.minY), anchor: .top,
                              proposal: ProposedViewSize(width: bounds.width, height: nil))
    }
}
