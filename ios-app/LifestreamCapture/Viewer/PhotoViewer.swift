import Cockpit
import HomeLink
import LifestreamCaptureCore
import MapKit
import SwiftUI
import UIKit

struct PhotoViewer: View {
    struct Opening: Identifiable {
        let id = UUID()
        let photos: [String]
        let at: Int
    }

    let photos: [String]
    let leave: (LifeRoute) -> Void
    @State private var at: Int
    @State private var layer = true
    @AppStorage("photoViewer.info") private var info = false
    @State private var zoomed = false
    @GestureState private var dragging: Dragging
    @State private var sizes: [String: CGSize] = [:]
    @StateObject private var facts = PhotoFactsReads()
    @StateObject private var reads = InspectorReads()
    @StateObject private var player = ViewerPlayer()
    @StateObject private var acts = Inspector.MadeActs()
    @State private var went: [String: InspectorReads.Went] = [:]
    @State private var seeing: InspectorReads.Went?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.voiceNotes) private var voiceNotes

    private struct Dragging: Equatable {
        var axis: Axis?
        var move: CGSize = .zero
    }

    private static let closing: CGFloat = 110
    private static let opening: CGFloat = 60
    private static let gap: CGFloat = 16

    init(photos: [String], at: Int, leave: @escaping (LifeRoute) -> Void) {
        self.photos = photos
        self.leave = leave
        _at = State(initialValue: min(max(0, at), max(0, photos.count - 1)))
        _dragging = GestureState(initialValue: Dragging(), resetTransaction: AppRuntime.runsStill ? Transaction()
            : Transaction(animation: .easeOut(duration: Cockpit.Duration.base)))
    }

    private var hash: String? { photos.indices.contains(at) ? photos[at] : nil }

    var body: some View {
        let read = hash.flatMap { facts.read[$0] }
        let photo = read?.photo
        let words = photo.map { PhotoWords($0, faces: HomePictures.shared, refused: $0.described?.ask.flatMap { acts.failed[Inspector.MadeActs.key($0)] },
                                            went: hash.flatMap { went[$0] }) }
        let made = photo?.described
        let act = hash.flatMap { hash in
            made.flatMap { Inspector.MadeAct(made: $0, verb: .describe, acts: acts) { await facts.again(hash) } }
        }
        PhotoViewerFrame(facts: known(read, words), layer: layer, info: info, size: hash.flatMap { sizes[$0] },
                         ground: 1 - min(1, lowered / 400), close: { dismiss() },
                         toggleInfo: { change(Cockpit.Duration.base) { info.toggle() } },
                         lowerInfo: { change(Cockpit.Duration.base) { info = false } },
                         open: { link in
                             if link == .sent { seeing = hash.flatMap { went[$0] } } else if let route = words?.route(link) { leave(route) }
                         },
                         picture: { pager(said: words?.facts.spoken ?? "Photo") },
                         map: {
                             if let place = photo?.place { PhotoPlaceMap(place: place).id(place.slug) }
                         },
                         act: act) {
            if let play = photo?.play, player.play == play, player.bar {
                VideoBar(state: player.state, elapsed: player.elapsed, length: player.length, muted: player.muted,
                         toggle: { player.toggle() }, seek: { player.seek($0, done: $1) }, mute: { player.mute() })
            }
        }
        .background {
            ForEach(photo?.people ?? []) { person in
                Color.clear.readsFace(person.photo?.hash, size: .portrait)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("viewer")
        .presentationBackground(.clear)
        .preferredColorScheme(.dark)
        .environmentObject(reads)
        .task(id: at) { facts.want(neighbours) }
        .task(id: photo?.play) { player.show(photo?.play, recording: recording) }
        .readsAgain(unread: { player.unreached }) { player.again(recording: recording) }
        .task(id: photo?.described?.ask) {
            guard let hash, let ask = photo?.described?.ask, went[hash] == nil, let read = try? await reads.went(ask) else { return }
            went[hash] = read
        }
        .sheet(item: $seeing) { went in
            Inspector.SentSheet(seq: went.row.seq).environmentObject(reads)
        }
        .readsAgain(failed: { hash.flatMap(facts.failure) }) {
            if let hash { facts.want([hash]) }
        }
        .readsAgain(while: acts.awaits(made)) {
            if let hash { await facts.again(hash) }
        }
        .onDisappear {
            facts.stop()
            player.end(recording: recording)
        }
    }

    private var recording: Bool { voiceNotes?.phase.isRecording == true }

    private var neighbours: [String] {
        [at, at - 1, at + 1].filter(photos.indices.contains).map { photos[$0] }
    }

    private func known(_ read: PhotoFactsReads.Read?, _ words: PhotoWords?) -> PhotoViewerFacts {
        switch read {
        case .read: words.map { .read($0.facts) } ?? .reading
        case .failed(.missing): .read(PhotoFacts(title: "Photo", spoken: "Photo"))
        case .failed(.reach): .failed("This photo's details aren't on this iPhone yet.")
        case .failed(.unpaired): .failed("Pair with Lifestream to see this.")
        case .failed(.busy(let words, _, _, _)): .failed(words)
        case .failed(.refused(let words)), .failed(.failed(let words)), .failed(.unknown(let words)):
            .failed(Inspector.Family.sentence(words))
        case .reading, nil: .reading
        }
    }


    private var lowered: CGFloat {
        dragging.axis == .vertical && !info ? max(0, dragging.move.height) : 0
    }

    private var shift: CGFloat {
        guard dragging.axis == .horizontal else { return 0 }
        let move = dragging.move.width
        return (at == 0 && move > 0) || (at == photos.count - 1 && move < 0) ? move / 3 : move
    }

    private func pager(said: String) -> some View {
        let acts = PhotoPage.Acts(said: said, tap: { change(Cockpit.Duration.fast) { layer.toggle() } },
                                  next: { step(1) }, previous: { step(-1) },
                                  info: { change(Cockpit.Duration.base) { info.toggle() } }, close: { dismiss() })
        return GeometryReader { box in
            ZStack {
                ForEach([at - 1, at, at + 1].filter(photos.indices.contains), id: \.self) { index in
                    let hash = photos[index]
                    let read = facts.read[hash]?.photo
                    PhotoPage(hash: hash, play: read?.play, known: read != nil, current: index == at, info: info, layer: layer,
                              zoomed: index == at ? $zoomed : .constant(false), player: player, drawn: { sizes[hash] = $0 },
                              acts: acts)
                        .frame(width: box.size.width, height: box.size.height)
                        .offset(x: CGFloat(index - at) * (box.size.width + Self.gap) + shift)
                        .accessibilityHidden(index != at)
                }
            }
            .frame(width: box.size.width, height: box.size.height)
            .contentShape(Rectangle())
            .offset(y: lowered)
            .scaleEffect(1 - min(0.25, lowered / 1600))
            .simultaneousGesture(drag(width: box.size.width), isEnabled: !zoomed)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("viewer.count")
        .accessibilityValue(AppRuntime.isUITesting ? "\(at + 1) of \(photos.count)" : "")
        .onChange(of: at) { zoomed = false }
    }

    private func drag(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12)
            .updating($dragging) { drag, dragging, _ in
                if dragging.axis == nil {
                    dragging.axis = abs(drag.translation.width) > abs(drag.translation.height) ? .horizontal : .vertical
                }
                dragging.move = drag.translation
            }
            .onEnded { drag in
                let move = drag.translation, flung = drag.predictedEndTranslation
                if abs(move.width) > abs(move.height) {
                    let by = move.width < -width / 4 || flung.width < -width / 2 ? 1 : move.width > width / 4 || flung.width > width / 2 ? -1 : 0
                    return step(by)
                }
                if move.height < -Self.opening, !info {
                    change(Cockpit.Duration.base) { info = true }
                } else if move.height > Self.closing, info {
                    change(Cockpit.Duration.base) { info = false }
                } else if move.height > Self.closing || flung.height > Self.closing * 3, !info {
                    dismiss()
                }
            }
    }

    private func step(_ by: Int) {
        let next = at + by
        guard by != 0, photos.indices.contains(next) else { return }
        change(Cockpit.Duration.base) { at = next }
    }

    private func change(_ duration: Double, _ body: () -> Void) {
        if AppRuntime.runsStill { return body() }
        withAnimation(.easeOut(duration: reduceMotion ? Cockpit.Duration.fast : duration), body)
    }
}

extension View {
    func photoViewer(_ opening: Binding<PhotoViewer.Opening?>, follow: @escaping (LifeRoute) -> Void) -> some View {
        modifier(PhotoViewerCover(opening: opening, follow: follow))
    }
}

private struct PhotoViewerCover: ViewModifier {
    @Binding var opening: PhotoViewer.Opening?
    let follow: (LifeRoute) -> Void
    @State private var leaving: LifeRoute?

    func body(content: Content) -> some View {
        content.fullScreenCover(item: $opening, onDismiss: {
            guard let route = leaving else { return }
            leaving = nil
            follow(route)
        }) { opening in
            PhotoViewer(photos: opening.photos, at: opening.at) { route in
                leaving = route
                self.opening = nil
            }
        }
    }
}


struct PhotoPage: View {
    let hash: String
    let play: HomeLink.Photo.Play?
    let known: Bool
    let current: Bool
    let info: Bool
    let layer: Bool
    @Binding var zoomed: Bool
    @ObservedObject var player: ViewerPlayer
    let drawn: (CGSize) -> Void
    let acts: Acts
    @GestureState private var pressed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    struct Acts {
        let said: String
        let tap: () -> Void
        let next: () -> Void
        let previous: () -> Void
        let info: () -> Void
        let close: () -> Void
        var live: (() -> Void)?
    }

    private static let underButtons = Cockpit.Space.s3 + Cockpit.Size.controlMd + Cockpit.Space.s2

    var body: some View {
        if let play, !play.live {
            VideoPage(hash: hash, current: current, player: player, drawn: drawn, acts: acts)
        } else {
            picture(live: play?.live == true && (!current || player.live))
        }
    }

    static func deepens(known: Bool, play: HomeLink.Photo.Play?) -> Bool {
        known && play?.live != false
    }

    private func picture(live: Bool) -> some View {
        Inspector.Reading(missing: "This picture is not in Lifestream.", {
            try await HomePictures.shared.read(hash, .screen, side: PictureDecode.largest)
        }, skeleton: { Loading(size: .page) }) { image in
            if let image {
                ZoomedPhoto(hash: hash, screen: image, current: current, info: info, zoomed: $zoomed,
                            deepens: Self.deepens(known: known, play: play), acts: live ? liveActs : acts,
                            moved: live ? player.moved : nil)
                    .overlay {
                        if live, current {
                            PlayerSurface(player: player.player)
                                .opacity(player.moving ? 1 : 0)
                                .animation(reduceMotion ? nil : .easeOut(duration: Cockpit.Duration.base), value: player.moving)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                    }
                    .overlay { if live, layer { badge(on: image.size) } }
                    .simultaneousGesture(LongPressGesture(minimumDuration: 0.3).sequenced(before: DragGesture(minimumDistance: 0))
                        .updating($pressed) { value, state, _ in
                            if case .second(true, _) = value { state = true }
                        }, isEnabled: live && current && !zoomed)
                    .onChange(of: pressed) { _, pressed in player.press(pressed) }
                    .onAppear { drawn(image.size) }
            } else {
                Inspector.Line(text: "This file is not a picture.")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
    }

    private var liveActs: Acts {
        let (acts, player) = (acts, player)
        return Acts(said: acts.said, tap: { if !player.pressing { acts.tap() } }, next: acts.next, previous: acts.previous,
                    info: acts.info, close: acts.close, live: { player.playMotion() })
    }

    private func badge(on size: CGSize) -> some View {
        GeometryReader { box in
            let fitted = min(box.size.width / max(size.width, 1), box.size.height / max(size.height, 1))
            let x = (box.size.width - size.width * fitted) / 2, y = (box.size.height - size.height * fitted) / 2
            LiveBadge()
                .fixedSize()
                .offset(x: x + Cockpit.Space.s3, y: max(y + Cockpit.Space.s3, Self.underButtons))
        }
        .allowsHitTesting(false)
        .transition(.opacity)
    }
}

private struct ZoomedPhoto: View {
    let hash: String
    let screen: UIImage
    let current: Bool
    let info: Bool
    @Binding var zoomed: Bool
    let deepens: Bool
    let acts: PhotoPage.Acts
    let moved: Int?
    @EnvironmentObject private var reads: InspectorReads
    @Environment(\.displayScale) private var displayScale
    @State private var scale: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1
    @State private var shift: CGSize = .zero
    @GestureState private var pan: CGSize = .zero
    @State private var deeper = false
    @State private var original: UIImage?

    private static let most: CGFloat = 6

    var body: some View {
        GeometryReader { frame in
            let most = original.map { Self.past($0, in: frame.size, scale: displayScale) } ?? Self.most
            let zoom = scale * pinch
            Image(uiImage: original ?? screen)
                .resizable()
                .scaledToFit()
                .scaleEffect(zoom)
                .offset(held(CGSize(width: shift.width + pan.width, height: shift.height + pan.height), zoom: zoom, in: frame.size))
                .frame(width: frame.size.width, height: frame.size.height)
                .contentShape(Rectangle())
                .gesture(MagnifyGesture()
                    .updating($pinch) { value, state, _ in state = value.magnification }
                    .onEnded { value in
                        scale = min(most, max(1, scale * value.magnification))
                        if scale == 1 { shift = .zero }
                    })
                .simultaneousGesture(DragGesture()
                    .updating($pan) { value, state, _ in state = value.translation }
                    .onEnded { value in
                        shift = held(CGSize(width: shift.width + value.translation.width, height: shift.height + value.translation.height),
                                     zoom: scale, in: frame.size)
                    }, isEnabled: scale > 1)
                .gesture(TapGesture(count: 2).onEnded { back() }, isEnabled: scale > 1)
                .onTapGesture { acts.tap() }
                .onChange(of: zoom) { _, zoom in
                    zoomed = zoom != 1
                    if zoom > Self.past(screen, in: frame.size, scale: displayScale) { deeper = true }
                }
                .onChange(of: most) { _, most in
                    if scale > most { withAnimation(.snappy) { scale = most } }
                }
                .onChange(of: current) { _, current in if !current { whole() } }
                .onChange(of: info) { _, info in if info { whole() } }
                .accessibilityElement()
                .accessibilityLabel(acts.said)
                .accessibilityAddTraits(.isImage)
                .accessibilityAction(named: "Next photo", acts.next)
                .accessibilityAction(named: "Previous photo", acts.previous)
                .accessibilityAction(named: "Info", acts.info)
                .accessibilityAction(named: "Close", acts.close)
                .accessibilityActions {
                    if let live = acts.live { Button("Play Live Photo", action: live) }
                }
                .accessibilityIdentifier(current ? "viewer.photo" : "viewer.page")
                .accessibilityValue(AppRuntime.isUITesting
                    ? "\(original == nil ? "screen" : "original") \(hash.dropFirst("sha256:".count).prefix(12))\(scale > 1 ? " zoomed" : "")"
                        + (moved.map { " live \($0)" } ?? "")
                    : "")
                .task(id: deeper && deepens) {
                    guard deeper, deepens, original == nil else { return }
                    let box = CGSize(width: frame.size.width * displayScale, height: frame.size.height * displayScale)
                    let zoom = Double(Self.most)
                    var decoded: UIImage?
                    if let data = try? await reads.original(hash) {
                        decoded = await Task.detached(priority: .userInitiated) {
                            PictureDecode.decode(data, fittedIn: box, zoom: zoom).map { UIImage(cgImage: $0) }
                        }.value
                    }
                    guard let decoded else { return deeper = false }
                    original = decoded
                }
        }
    }

    private func back() {
        if AppRuntime.runsStill { return whole() }
        withAnimation(.snappy) { whole() }
    }

    private func whole() {
        scale = 1
        shift = .zero
    }

    private func held(_ offset: CGSize, zoom: CGFloat, in box: CGSize) -> CGSize {
        let fitted = min(box.width / screen.size.width, box.height / screen.size.height)
        let width = screen.size.width * fitted * zoom, height = screen.size.height * fitted * zoom
        let x = max(0, (width - box.width) / 2), y = max(0, (height - box.height) / 2)
        return CGSize(width: min(x, max(-x, offset.width)), height: min(y, max(-y, offset.height)))
    }

    static func past(_ picture: UIImage, in box: CGSize, scale: CGFloat) -> CGFloat {
        let fitted = min(box.width * scale / picture.size.width, box.height * scale / picture.size.height)
        return max(1, 1 / fitted)
    }
}


@MainActor
final class PhotoFactsReads: ObservableObject {
    enum Read {
        case reading
        case read(HomeLink.Photo)
        case failed(LifeReader.Failure)

        var photo: HomeLink.Photo? {
            if case .read(let photo) = self { return photo }
            return nil
        }
    }

    @Published private(set) var read: [String: Read] = [:]
    private var reading: [String: Task<Void, Never>] = [:]
    private var stopped = false
    private let life: LifeReader

    init(life: LifeReader = AppRuntime.shared.life) {
        self.life = life
    }

    func want(_ hashes: [String]) {
        for hash in hashes where !stopped && reading[hash] == nil && wants(hash) {
            if read[hash] == nil { read[hash] = .reading }
            reading[hash] = Task { [life] in
                let answer: Read
                do {
                    answer = .read(try await life.photo(hash))
                } catch is CancellationError {
                    return
                } catch let failure as LifeReader.Failure {
                    answer = .failed(failure)
                } catch {
                    answer = .failed(.refused(String(describing: error)))
                }
                guard !Task.isCancelled else { return }
                self.read[hash] = answer
                self.reading[hash] = nil
            }
        }
    }

    func again(_ hash: String) async {
        guard !stopped else { return }
        await reading[hash]?.value
        guard !stopped, reading[hash] == nil else { return }
        let task = Task { [life] in
            do {
                let photo = try await life.photo(hash)
                guard !Task.isCancelled else { return }
                self.read[hash] = .read(photo)
            } catch {
            }
            self.reading[hash] = nil
        }
        reading[hash] = task
        await task.value
    }

    func stop() {
        stopped = true
        reading.values.forEach { $0.cancel() }
        reading = [:]
    }

    func failure(_ hash: String) -> LifeReader.Failure? {
        if case .failed(let failure) = read[hash] { return failure }
        return nil
    }

    private func wants(_ hash: String) -> Bool {
        switch read[hash] {
        case nil: true
        case .failed(.reach), .failed(.busy): true
        case .read, .reading, .failed: false
        }
    }
}

@MainActor
struct PhotoWords {
    let photo: HomeLink.Photo
    let facts: PhotoFacts

    init(_ photo: HomeLink.Photo, faces: Pictures<UIImage>, refused: Inspector.MadeActs.Unlanded? = nil, went: InspectorReads.Went? = nil) {
        self.photo = photo
        let at = photo.atMs.map(Words.date(ms:))
        let clock = at.map(Words.clock)
        let moment = at.map { Words.stamp($0) }
        let place = photo.place.map { PhotoFacts.Place(name: $0.name, area: Self.area($0.area)) }
        let titled: (String, PhotoFacts.Link?, String?) = if let place {
            (place.name, .place, moment)
        } else if let area = photo.area.flatMap({ $0.city ?? $0.region ?? $0.country }) {
            (area, nil, moment)
        } else if let moment {
            (moment, .moment, nil)
        } else {
            ("Photo", nil, nil)
        }
        let date = at.map { PhotoFacts.Row(Words.fullDate($0), clock) }
        let when = at.map { Words.longDate($0) + " " + Words.clock($0) } ?? ""
        let said: [String?] = ["Photo", place?.name ?? photo.area.flatMap { $0.city ?? $0.region ?? $0.country }, when, photo.caption]
        facts = PhotoFacts(
            title: titled.0, titleOpens: titled.1, moment: titled.2,
            spoken: said.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "),
            caption: photo.caption, made: photo.described?.line.map { PhotoFacts.Row($0) }, refused: refused.map(Self.said),
            sent: went.map { PhotoFacts.Row(SentWords.fact($0.row, kinds: $0.kinds), $0.row.what == "ask" ? PhotoFacts.seeSent : nil) },
            sentOpens: went?.row.what == "ask",
            people: photo.people.map { PhotoFacts.Person(id: $0.id, name: $0.me ? "You" : $0.name, photo: faces.face($0.photo?.hash)) },
            place: place, date: date, camera: Self.camera(photo), chat: photo.chat.map(Self.chat))
    }

    private static func said(_ unlanded: Inspector.MadeActs.Unlanded) -> String {
        switch unlanded.said {
        case .notSent: ReachWords.notSent
        case .saving: ReachWords.saving
        case .refused(let words), .unknown(let words): words
        }
    }

    func route(_ link: PhotoFacts.Link) -> LifeRoute? {
        switch link {
        case .place: photo.place.map { .place($0.slug) }
        case .person(let id): .person(id)
        case .chat: photo.chat.map { .day($0.day, focus: $0.focus) }
        case .sent: nil
        case .moment: photo.day.map { .day($0, focus: photo.focus) }
        }
    }

    private static func area(_ area: HomeLink.Photo.Area) -> String? {
        let words = [area.city, area.region].compactMap { $0 }
        return words.isEmpty ? area.country : words.joined(separator: ", ")
    }

    private static func camera(_ photo: HomeLink.Photo) -> PhotoFacts.Row? {
        let road: String? = switch photo.from {
        case "phone": "From your iPhone"
        case "mac": "From your Mac's Photos"
        case "camera": "Taken in Lifestream"
        case nil: nil
        case let product?: "From " + ProductsBook.shared.names.name(of: product)
        }
        if let camera = photo.camera { return PhotoFacts.Row(camera.name, road) }
        guard let road else { return nil }
        let kind = switch photo.kind {
        case "screenshot": "Screenshot"
        case "video": "Video"
        case "image": "Image"
        default: "Photo"
        }
        return PhotoFacts.Row(kind, road)
    }

    private static func chat(_ chat: HomeLink.Photo.Chat) -> PhotoFacts.Row {
        let network = ProductsBook.shared.names.name(of: chat.network)
        let place = chat.group ? chat.title + " · " + network : network
        if chat.mine { return PhotoFacts.Row("You sent it", place) }
        if let sender = chat.sender { return PhotoFacts.Row("Sent by " + sender.name, place) }
        return PhotoFacts.Row(chat.title, network)
    }
}

private struct PhotoPlaceMap: View {
    let place: HomeLink.Photo.Place

    var body: some View {
        let centre = CLLocationCoordinate2D(latitude: place.latitude, longitude: place.longitude)
        let span = max(400, place.radiusM * 6)
        GeometryReader { proxy in
            let rect = StillMap.rect(around: centre, metres: span, size: proxy.size)
            let reach = 2 * place.radiusM * MKMapPointsPerMeterAtLatitude(centre.latitude) * proxy.size.width / rect.width
            ZStack {
                StillMap(rect: rect)
                Circle()
                    .fill(ReachCircle.fill)
                    .overlay(Circle().stroke(ReachCircle.edge, lineWidth: ReachCircle.edgeWidth))
                    .frame(width: reach, height: reach)
                PlaceDisc(diameter: 14)
            }
        }
        .background(MapGround.land)
        .accessibilityHidden(true)
    }
}
