import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct ThreadVoice: View {
    let voice: Inspector.ThreadMessage.Voice
    let mine: Bool
    let surface: NSObject
    @ObservedObject private var player = NotePlayer.shared

    var body: some View {
        let state = voice.hash.map { player.state(of: .held($0)) } ?? .idle
        bar(state)
        if case .failed = state { InPlaceLine(VoiceWords.unplayed, retry: toggle) }
    }

    private var toggle: (() -> Void)? {
        voice.hash.map { hash in { [player, surface] in _ = player.toggle(.held(hash), of: surface) } }
    }

    private func bar(_ state: NotePlayer.State) -> VoiceBar {
        switch state {
        case .loading:
            return VoiceBar(seconds: voice.seconds, loading: true, mine: mine, toggle: toggle)
        case let .playing(at, of), let .paused(at, of):
            let length = of > 0 ? of : voice.seconds
            let playing = if case .playing = state { true } else { false }
            return VoiceBar(seconds: length, played: length.map { $0 > 0 ? at / $0 : 0 } ?? 0, playing: playing, mine: mine, toggle: toggle)
        case .idle, .failed:
            return VoiceBar(seconds: voice.seconds, mine: mine, toggle: toggle)
        }
    }
}

struct MessagePictures: View {
    let hashes: [String]
    let open: (String) -> Void

    var body: some View {
        let shown = Array(hashes.prefix(4))
        Group {
            if shown.count == 1 {
                shot(shown[0], width: 240, height: 200)
            } else {
                Grid(horizontalSpacing: 2, verticalSpacing: 2) {
                    if shown.count == 3 {
                        GridRow { shot(shown[0], width: 240, height: 140).gridCellColumns(2) }
                        GridRow { shot(shown[1], width: 119, height: 119); shot(shown[2], width: 119, height: 119) }
                    } else {
                        GridRow { shot(shown[0], width: 119, height: 119); shot(shown[1], width: 119, height: 119) }
                        if shown.count == 4 {
                            GridRow {
                                shot(shown[2], width: 119, height: 119)
                                shot(shown[3], width: 119, height: 119)
                                    .overlay {
                                        if hashes.count > 4 {
                                            Cockpit.Color.scrim.overlay {
                                                Text("+\(hashes.count - 4)").cockpit(.title3).foregroundStyle(Cockpit.Color.text)
                                            }
                                            .allowsHitTesting(false)
                                        }
                                    }
                            }
                        }
                    }
                }
            }
        }
        .clipShape(Bubble.shape)
        .drawingGroup()
    }

    private func shot(_ hash: String, width: CGFloat, height: CGFloat) -> some View {
        Button { open(hash) } label: {
            Inspector.Picture(hash: hash, width: width, height: height, corner: 0)
                .frame(width: width, height: height)
                .background(Cockpit.Color.well)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Photo")
        .accessibilityHint("Opens it in the photo viewer")
        .accessibilityIdentifier("inspector.message.photo")
    }
}
