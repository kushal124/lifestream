import Cockpit
import HomeLink
import ImageIO
import LifestreamCaptureCore
import PhotosUI
import SwiftUI
import UIKit

struct HeadFace: View {
    let name: String?
    let photo: String?
    let held: Bool
    @ObservedObject var model: PersonModel
    @ObservedObject var photos: PersonPhotosModel
    var pushes = false
    @ObservedObject private var book = PeopleBook.shared
    @State private var picking = false
    @State private var theirs = false
    @State private var shooting = false
    @State private var item: PhotosPickerItem?
    @State private var handed: Handed?
    @State private var picture: Picture?
    @State private var making = false

    struct Picture: Identifiable {
        let id = UUID()
        let image: CGImage
        let drawnDown: Double
        let start: MoveAndScale.Square?
    }

    private struct Handed {
        let data: Data?
        let box: [Double]?
    }

    var body: some View {
        let face = model.choosing ?? photo
        let drawn = HomePictures.shared.face(face)
        let takes = book.takes && held && pushes
        let shown = PersonFace(name, photo: drawn, size: .head, badge: takes, loading: face != nil)
        Group {
            if takes {
                Menu {
                    if !photos.photos.isEmpty {
                        Button { theirs = true } label: { Label { Text("Choose from Their Photos") } icon: { Image(icon: .person, size: .md) } }
                            .accessibilityIdentifier("person.face.theirs")
                    }
                    Button(action: pick) { Label { Text("Choose from Library") } icon: { Image(icon: .photos, size: .md) } }
                        .accessibilityIdentifier("person.face.library")
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { shooting = true } label: { Label { Text("Take Photo") } icon: { Image(icon: .photo, size: .md) } }
                    }
                } label: {
                    shown
                }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .disabled(model.acting)
                .accessibilityLabel(drawn == nil ? "Add photo" : "Change photo")
                .accessibilityHint("Offers their photos, your library or the camera")
            } else {
                shown
            }
        }
        .accessibilityIdentifier("person.face")
        .facesValue(face, drawn: drawn)
        .readsFace(face, size: .head)
        .task(id: takes) {
            guard takes else { return }
            await photos.read()
            if AppRuntime.asked("--ui-test-their-photos"), !photos.photos.isEmpty { theirs = true }
        }
        .photosPicker(isPresented: $picking, selection: $item, matching: .images, preferredItemEncoding: .current)
        .onChange(of: item) { _, chosen in
            guard let chosen else { return }
            item = nil
            Task { await open(try? await chosen.loadTransferable(type: Data.self), box: nil) }
        }
        .modifier(OpensTheirPhotos(open: $theirs, pushes: pushes, opened: openHanded) {
            TheirPhotos(photos: photos, pushed: pushes) { photo, data in
                handed = Handed(data: data, box: photo.box)
                theirs = false
            }
        })
        .fullScreenCover(isPresented: $shooting, onDismiss: openHanded) {
            CameraPicker(onImage: { data, _ in
                handed = Handed(data: data, box: nil)
                shooting = false
            }, onCancel: { shooting = false })
            .ignoresSafeArea()
        }
        .fullScreenCover(item: $picture) { picture in
            MoveAndScale(picture.image, drawnDown: picture.drawnDown, start: picture.start, cancel: { self.picture = nil }) { square in
                Task { await choose(square, of: picture.image) }
            }
            .statusBarHidden()
        }
    }

    private func pick() {
        if CannedHome.picksPhoto {
            Task { await open(CannedHome.pickedPhoto, box: nil) }
        } else {
            picking = true
        }
    }

    private func openHanded() {
        guard let handed else { return }
        self.handed = nil
        Task { await open(handed.data, box: handed.box) }
    }

    private func open(_ data: Data?, box: [Double]?) async {
        let opened = await Task.detached(priority: .userInitiated) { () -> Picture? in
            guard let data, let image = PhotoSquare.picture(data) else { return nil }
            let photo = PhotoSquare.upright(data), picture = CGSize(width: image.width, height: image.height)
            let start = box.flatMap { box in photo.flatMap { PeopleDetails.around(box, photo: $0, picture: picture) } }
            return Picture(image: image, drawnDown: photo.map { Double(min(1, picture.width / $0.width)) } ?? 1,
                           start: start.map { MoveAndScale.Square(x: $0.x, y: $0.y, side: $0.side) })
        }.value
        guard let opened else {
            model.unreadable()
            return
        }
        picture = opened
    }

    private func choose(_ square: MoveAndScale.Square, of image: CGImage) async {
        guard !making, held else { return }
        making = true
        defer { making = false }
        guard let jpeg = await Task.detached(priority: .userInitiated, operation: { PhotoSquare.jpeg(image, square) }).value else {
            model.unreadable()
            picture = nil
            return
        }
        await model.choose(jpeg)
        picture = nil
    }
}

private struct OpensTheirPhotos<Photos: View>: ViewModifier {
    @Binding var open: Bool
    let pushes: Bool
    let opened: () -> Void
    @ViewBuilder let photos: () -> Photos

    func body(content: Content) -> some View {
        if pushes {
            content
                .navigationDestination(isPresented: $open, destination: photos)
                .onChange(of: open) { _, open in if !open { opened() } }
        } else {
            content.sheet(isPresented: $open, onDismiss: opened, content: photos)
        }
    }
}

private struct TheirPhotos: View {
    @ObservedObject var photos: PersonPhotosModel
    var pushed = false
    let choose: (HomeLink.People.Photos.Photo, Data?) -> Void
    @StateObject private var reads = InspectorReads()
    @State private var page = 0
    @State private var taking = false
    @Environment(\.dismiss) private var dismiss

    static let perPage = 24

    private struct Shot: Identifiable {
        let id: Int
        let photo: HomeLink.People.Photos.Photo
    }

    private struct Blank: Identifiable {
        let id: Int
    }

    private var pages: Int {
        max(1, (photos.total + Self.perPage - 1) / Self.perPage)
    }

    var body: some View {
        Group {
            if pushed {
                grid
            } else {
                NavigationStack {
                    grid.sheetCloseBar()
                }
            }
        }
        .task(id: min(page, pages - 1)) { await photos.need((min(page, pages - 1) + 1) * Self.perPage) }
        .environmentObject(reads)
    }

    private var grid: some View {
        let pages = pages
        let shown = min(page, pages - 1)
        let first = shown * Self.perPage
        let ground = pushed ? Cockpit.Color.surface : Cockpit.Color.canvas
        return ScrollViewReader { scroll in
            ScrollView {
                VStack(alignment: .leading, spacing: Cockpit.Space.s2) {
                    if photos.photos.count <= first && photos.failure == nil {
                        PhotoGrid((0..<9).map(Blank.init), columns: 3, label: { _ in "Photo" }, open: { _ in }) { _ in Color.clear }
                            .reading(true)
                    } else {
                        let shots = photos.photos.indices.dropFirst(first).prefix(Self.perPage).map { Shot(id: $0, photo: photos.photos[$0]) }
                        PhotoGrid(shots, columns: 3, label: { PeopleWords.photo($0.photo) }, open: take) { shot in
                            PlaceShot.Picture(hash: shot.photo.blob)
                                .accessibilityIdentifier("person.photos.\(shot.id)")
                        }
                    }
                    if let failure = photos.failure, let words = PeopleWords.failure(failure) {
                        InPlaceLine(words) { Task { await photos.retry(first + Self.perPage) } }
                    }
                }
                .padding(Cockpit.Space.s4)
                .id("top")
            }
            .accessibilityIdentifier("person.photos")
            .onChange(of: shown) { scroll.scrollTo("top", anchor: .top) }
        }
        .background(ground)
        .pageFoot {
            if pages > 1 {
                ValueStepper("Page", value: Binding(get: { shown }, set: { page = $0 }), steps: Array(0..<pages),
                             less: "Newer", more: "Older") { "\($0 + 1) of \(pages)" }
                    .accessibilityIdentifier("person.photos.pager")
                    .floatingPill()
            }
        }
        .navigationTitle("Their Photos")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func take(_ shot: Shot) {
        guard !taking else { return }
        taking = true
        Task {
            let data = try? await reads.original(shot.photo.blob)
            choose(shot.photo, data)
        }
    }
}

enum PhotoSquare {
    static let decoded = 4_096
    static let side = 1_024

    nonisolated static func picture(_ data: Data) -> CGImage? {
        CameraThumbnail.make(from: data, maxPixelSize: decoded)?.cgImage
    }

    nonisolated static func upright(_ data: Data) -> CGSize? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? CGFloat,
              let height = properties[kCGImagePropertyPixelHeight] as? CGFloat else { return nil }
        let turned = (properties[kCGImagePropertyOrientation] as? Int).map { $0 >= 5 } ?? false
        return turned ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
    }

    nonisolated static func jpeg(_ picture: CGImage, _ square: MoveAndScale.Square) -> Data? {
        guard let cut = picture.cropping(to: CGRect(x: square.x, y: square.y, width: square.side, height: square.side)) else { return nil }
        let side = CGFloat(min(square.side, Self.side))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        format.preferredRange = .standard
        let bounds = CGRect(x: 0, y: 0, width: side, height: side)
        return UIGraphicsImageRenderer(size: bounds.size, format: format).jpegData(withCompressionQuality: 0.85) { context in
            context.cgContext.interpolationQuality = .high
            UIColor.white.setFill()
            context.fill(bounds)
            UIImage(cgImage: cut).draw(in: bounds)
        }
    }
}
