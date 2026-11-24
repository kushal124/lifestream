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

private struct Poster: View {
    let n: Int?
    var body: some View {
        Color.clear.overlay {
            if let n, let image = StandInPhoto.image(n, size: 300) {
                Image(decorative: image, scale: 1).resizable().scaledToFill()
            }
        }
        .clipped()
    }
}

private struct Tile: Identifiable {
    let id: Int
    let poster: Int?
    let length: Double?
}

@MainActor private func tiles(_ shown: [Tile]) -> some View {
    PhotoGrid(shown, columns: 3, label: { $0.length.map { "Video, \(VideoClock.length($0))" } ?? "Video" }, open: { _ in }) { tile in
        Poster(n: tile.poster).overlay(alignment: .bottomTrailing) { VideoMark(length: tile.length) }
    }
}

@MainActor let videoTileSheet = Sheet("video-tile", ios: 390, platforms: [.ios]) {
    Specimen("Posters drawn: 0:42, 2:10, an hour's 1:02:05") {
        tiles([Tile(id: 0, poster: 3, length: 42.4), Tile(id: 1, poster: 5, length: 130), Tile(id: 2, poster: 6, length: 3725)])
    }
    Specimen("A video only Takeout holds, and a message's: no length, the glyph alone") {
        tiles([Tile(id: 0, poster: 1, length: nil), Tile(id: 1, poster: 7, length: nil)])
    }
    Specimen("Its poster being made, or none can be, or the engine could not run: the box, its mark at once") {
        tiles([Tile(id: 0, poster: nil, length: 42), Tile(id: 1, poster: nil, length: nil), Tile(id: 2, poster: 2, length: 8)])
    }
    Specimen("A Live Photo: its still, no mark (its label says “Live Photo”)") {
        PhotoGrid([Tile(id: 0, poster: 4, length: nil)], columns: 3, label: { _ in "Live Photo" }, open: { _ in }) { tile in
            Poster(n: tile.poster)
        }
    }
}

@MainActor private func onPhoto<V: View>(_ n: Int = 6, @ViewBuilder _ content: () -> V) -> some View {
    content()
        .padding(.vertical, Cockpit.Space.s4)
        .frame(maxWidth: .infinity)
        .background { Poster(n: n) }
        .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.md, style: .continuous))
        .environment(\.cockpitSystemGlass, false)
}

@MainActor private func bar(_ state: VideoBar.State, _ elapsed: Double, _ length: Double?, muted: Bool = false,
                            held: Double? = nil) -> some View {
    onPhoto {
        set(VideoBar(state: state, elapsed: elapsed, length: length, muted: muted, toggle: {}, seek: { _, _ in }, mute: {}),
            \.forcedHeld, held)
    }
}

@MainActor let videoBarSheet = Sheet("video-bar", ios: 390, platforms: [.ios]) {
    Specimen("Paused at its start") { bar(.paused, 0, 42) }
    Specimen("Playing") { bar(.playing, 12.6, 42) }
    Specimen("Waiting for bytes at the start: the spinner in play’s place") { bar(.waiting, 0, 42) }
    Specimen("Waiting for bytes mid-play or after a seek: the scrubber still the person’s") { bar(.waiting, 31, 42) }
    Specimen("A finger on the scrubber: it thickens, the time follows the finger") { bar(.paused, 12, 42, held: 0.62) }
    Specimen("Muted") { bar(.playing, 12, 42, muted: true) }
    Specimen("An hour’s video: the slots as wide as 0:00:00") { bar(.playing, 760, 3725) }
    Specimen("Its length not known yet") { bar(.waiting, 0, nil) }
    Specimen("A class no player here plays, or this one cannot") { bar(.said("This video can't play here."), 0, 42) }
    Specimen("The home out of reach: the page lack; it plays once the home answers") {
        bar(.said("This video can't play right now."), 0, 42)
    }
}

@MainActor let liveBadgeSheet = Sheet("live-badge", ios: 390, platforms: [.ios]) {
    Specimen("Over a photo’s top leading corner, 12 in") {
        onPhoto(4) {
            LiveBadge().padding(Cockpit.Space.s3).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(height: 160)
    }
    Specimen("Over a bright photo") {
        onPhoto(1) {
            LiveBadge().padding(Cockpit.Space.s3).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(height: 160)
    }
    Specimen("The glyph, at 16, 20 and 24") {
        HStack(spacing: Cockpit.Space.s4) {
            Icon(.live, size: .sm)
            Icon(.live, size: .md)
            Icon(.live, size: .lg)
            Icon(.sound, size: .md)
            Icon(.muted, size: .md)
        }
        .foregroundStyle(Cockpit.Color.text)
    }
}

@MainActor private let beach = PhotoFacts(
    title: "Harbor Terrace", titleOpens: .place, moment: "Sat 11 Oct · 18:42", spoken: "Video, Harbor Terrace, Saturday 11 October 18:42",
    people: [PhotoFacts.Person(id: "person:sam", name: "Sam Rivera")], date: PhotoFacts.Row("Saturday 11 October 2026", "18:42"))

@MainActor private func viewer(_ facts: PhotoViewerFacts = .read(beach), layer: Bool = true, scene: Int = 6, tall: Bool = false,
                                bar: VideoBar? = nil, live: Bool = false) -> some View {
    let size = tall ? CGSize(width: 9, height: 16) : CGSize(width: 4, height: 3)
    return Phone {
        PhotoViewerFrame(facts: facts, layer: layer, info: false, size: size, close: {}, toggleInfo: {}, lowerInfo: {},
                         open: { _ in }) {
            if let image = StandInPhoto.image(scene, size: tall ? 900 : 1200, height: tall ? 1600 : 900) {
                Image(decorative: image, scale: 1).resizable().scaledToFit()
                    .overlay(alignment: .topLeading) {
                        if live, layer { LiveBadge().padding(Cockpit.Space.s3) }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } map: {
            EmptyView()
        } bar: {
            if let bar { bar }
        }
    }
}

@MainActor private func transport(_ state: VideoBar.State, _ elapsed: Double = 12, _ length: Double? = 42) -> VideoBar {
    VideoBar(state: state, elapsed: elapsed, length: length, muted: false, toggle: {}, seek: { _, _ in }, mute: {})
}

@MainActor let videoViewerSheet = Sheet("video-viewer", ios: 390, platforms: [.ios]) {
    Specimen("A video playing: the bar at the layer’s foot, above the chips") { viewer(bar: transport(.playing)) }
    Specimen("A tap hides the layer, the bar with it") { viewer(layer: false, bar: transport(.playing)) }
    Specimen("A portrait video waiting for its first bytes: the poster, the spinner") {
        viewer(scene: 2, tall: true, bar: transport(.waiting, 0))
    }
    Specimen("This video can’t play here: the poster stays") { viewer(bar: transport(.said("This video can't play here."))) }
    Specimen("The home out of reach: the page lack in the bar’s place") {
        viewer(scene: 2, tall: true, bar: transport(.said("This video can't play right now.")))
    }
    Specimen("Its facts not ready: the picture alone; play, LIVE and Info wait") { viewer(.reading) }
    Specimen("A Live Photo: LIVE at its top leading corner, under the bar") { viewer(scene: 4, tall: true, live: true) }
    Specimen("A Live Photo, landscape, the layer hidden: LIVE with it") { viewer(layer: false, scene: 5, live: true) }
    Specimen("A Live Photo whose motion failed: its still, no LIVE, the bar’s words") {
        viewer(scene: 4, tall: true, bar: transport(.said("This video can't play right now.")))
    }
}
#endif
