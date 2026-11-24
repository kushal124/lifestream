#if os(macOS)
import SwiftUI
@testable import Cockpit


private struct Phone<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        content
            .safeAreaPadding(EdgeInsets(top: 47, leading: 0, bottom: 34, trailing: 0))
            .frame(width: 390, height: 844)
            .clipped()
            .padding(.horizontal, -Cockpit.Space.s4)
            .environment(\.cockpitSystemGlass, false)
    }
}

private struct Scene: View {
    var n = 1
    var wide = false
    var tall = false
    var body: some View {
        if let image = StandInPhoto.image(n, size: wide ? 1200 : 900, height: wide ? 900 : tall ? 1600 : 1200) {
            Image(decorative: image, scale: 1).resizable().scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

private struct StandInMap: View {
    var body: some View {
        ZStack {
            Cockpit.Color.mapLand
            ReachCircle(diameter: 64)
            PlaceDisc(diameter: 14)
        }
    }
}

@MainActor private func face(_ n: Int) -> Image? {
    StandInPhoto.image(n, size: 120).map { Image(decorative: $0, scale: 1) }
}

@MainActor private let terrace = PhotoFacts(
    title: "Harbor Terrace", titleOpens: .place, moment: "Sat 11 Oct · 18:42",
    spoken: "Photo, Harbor Terrace, Saturday 11 October 18:42, Two friends on a terrace by the sea at sunset.",
    caption: "Two friends on a terrace by the sea at sunset, string lights above them.",
    sent: PhotoFacts.Row("Sent to OpenAI, 11 Oct · 2 faces covered", PhotoFacts.seeSent), sentOpens: true,
    people: [PhotoFacts.Person(id: "person:sam", name: "Sam Rivera", photo: face(0)), PhotoFacts.Person(id: "person:maya", name: "Maya")],
    place: PhotoFacts.Place(name: "Harbor Terrace", area: "Seafront, Northbay"),
    date: PhotoFacts.Row("Saturday 11 October 2026", "18:42"),
    camera: PhotoFacts.Row("iPhone 17 Pro", "From your iPhone"))

@MainActor private let five = PhotoFacts(
    title: "Harbor Terrace", titleOpens: .place, moment: "Sat 11 Oct · 18:42", spoken: "Photo, Harbor Terrace",
    people: ["Sam Rivera", "Maya", "Alexandria Montgomery", "Jo", "Christopher Hale"].enumerated().map { index, name in
        PhotoFacts.Person(id: "person:\(index)", name: name, photo: index.isMultiple(of: 2) ? face(index) : nil)
    },
    date: PhotoFacts.Row("Saturday 11 October 2026", "18:42"))

@MainActor private let received = PhotoFacts(
    title: "Sun 12 Oct · 09:15", titleOpens: .moment, spoken: "Photo, Sunday 12 October 09:15",
    date: PhotoFacts.Row("Sunday 12 October 2026", "09:15"),
    chat: PhotoFacts.Row("Sent by Sam Rivera", "Weekend plans · WhatsApp"))

@MainActor private func viewer(_ facts: PhotoViewerFacts, layer: Bool = true, info: Bool = false, wide: Bool = false,
                                tall: Bool = false) -> some View {
    let size = wide ? CGSize(width: 4, height: 3) : tall ? CGSize(width: 9, height: 16) : CGSize(width: 3, height: 4)
    return Phone {
        PhotoViewerFrame(facts: facts, layer: layer, info: info, size: size,
                         close: {}, toggleInfo: {}, lowerInfo: {}, open: { _ in }) {
            Scene(n: wide ? 6 : 1, wide: wide, tall: tall)
        } map: {
            StandInMap()
        }
    }
}

@MainActor let photoViewerSheet = Sheet("photo-viewer", ios: 390, platforms: [.ios]) {
    Specimen("The light layer: the place, the moment, two people; the wash under the band") {
        viewer(.read(terrace), tall: true)
    }
    Specimen("A tap hides the whole layer") {
        viewer(.read(terrace), layer: false, tall: true)
    }
    Specimen("A landscape photo, below the band: no wash; a chat's image, its date the title, no chips") {
        viewer(.read(received), wide: true)
    }
    Specimen("The facts not read yet: the buttons alone, no skeleton") {
        viewer(.reading)
    }
}

@MainActor let photoViewerInfoSheet = Sheet("photo-viewer-info", ios: 390, hosted: true, platforms: [.ios]) {
    Specimen("Info: the caption, the people, the place, the date, the camera; Info pressed") {
        viewer(.read(terrace), info: true, tall: true)
    }
    Specimen("Five people, long names cut only past 72, the row scrolling sideways") {
        viewer(.read(five), info: true, tall: true)
    }
    Specimen("A chat's image: the date and the chat alone") {
        viewer(.read(received), info: true, wide: true)
    }
    Specimen("The home out of reach") {
        viewer(.failed("Can't reach Lifestream."), info: true)
    }
}
#endif
