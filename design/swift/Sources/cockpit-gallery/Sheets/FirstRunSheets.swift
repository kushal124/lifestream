#if os(macOS)
import AppKit
import SwiftUI
@testable import Cockpit


@MainActor private func standIns(_ count: Int) -> [Image] {
    (0..<count).compactMap { seed in StandInPhoto.image(seed).map { Image(decorative: $0, scale: 1) } }
}

@MainActor private let river: Image? = {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("../../../../river/river-2000.webp").standardizedFileURL
    return NSImage(contentsOf: url).map { Image(nsImage: $0) }
}()

@MainActor let stepMarksSheet = Sheet("step-marks", ios: 390, mac: 420) {
    Specimen("Pair done, Location here") { StepMarks([.done, .here, .ahead, .ahead, .ahead, .ahead]).frame(maxWidth: .infinity) }
    Specimen("Motion pressed past, Health here") { StepMarks([.done, .done, .past, .here, .ahead, .ahead]).frame(maxWidth: .infinity) }
    Specimen("Pair later, the last stream here") { StepMarks([.past, .done, .done, .done, .done, .here]).frame(maxWidth: .infinity) }
    Specimen("Check discs: settled, and found") {
        HStack(spacing: Cockpit.Space.s4) { CheckDisc(); CheckDisc(Cockpit.Color.engaged) }
    }
}

@MainActor let streamPictureSheet = Sheet("stream-picture", ios: 390, mac: 420) {
    Specimen("Location: the journey before, off, and the map with the person's place under the here mark") {
        VStack(spacing: Cockpit.Space.s3) {
            StreamPicture(.map()).frame(height: 220)
            StreamPicture(.map(off: true)).frame(height: 160)
            StreamPicture(.map(place: AnyView(Cockpit.Color.mapLand.overlay(MapGround.land.opacity(0.4))))).frame(height: 160)
        }
    }
    Specimen("Motion") { StreamPicture(.motion).frame(height: 220) }
    Specimen("Health") { StreamPicture(.health).frame(height: 220) }
    Specimen("Screen Time") { StreamPicture(.screenTime).frame(height: 220) }
    Specimen("Photos: before, the eight newest, limited to three chosen") {
        VStack(spacing: Cockpit.Space.s3) {
            StreamPicture(.photos()).frame(height: 180)
            StreamPicture(.photos(standIns(8))).frame(height: 180)
            StreamPicture(.photos(standIns(3), limited: true)).frame(height: 180)
        }
    }
    Specimen("Contacts: before, and the first letters of names") {
        VStack(spacing: Cockpit.Space.s3) {
            StreamPicture(.contacts()).frame(height: 120)
            StreamPicture(.contacts(["A", "M", "J", "R", "S"])).frame(height: 120)
        }
    }
    Specimen("Pair with your Mac: looking, joined; the Mac's iPhone step; the logo's mark") {
        VStack(spacing: Cockpit.Space.s4) {
            PairPicture(joined: false)
            PairPicture(joined: true)
            MacStepPicture()
            LogoMark()
        }
        .frame(maxWidth: .infinity)
    }
}

@MainActor private func pressed(_ style: CockpitButtonStyle) -> CockpitButtonStyle {
    var style = style
    style.forced = .pressed
    return style
}

@MainActor private func screen<Marks: View, Column: View, Foot: View>(
    centred: Bool = false, band: Bool = false, @ViewBuilder marks: () -> Marks, @ViewBuilder column: () -> Column,
    @ViewBuilder foot: () -> Foot
) -> some View {
    FirstRunFrame(scrolls: false, centred: centred, band: band ? river : nil, marks: marks, column: column, foot: foot)
        .frame(width: 342, height: 700)
        .overlay(RoundedRectangle(cornerRadius: Cockpit.Radius.lg).strokeBorder(Cockpit.Color.hairline, lineWidth: 1))
}

@MainActor let firstRunFrameSheet = Sheet("first-run-frame", ios: 390, mac: 420) {
    Specimen("Photos, before: the picture, the title, why it asks; Allow and Not now") {
        screen {
            StepMarks([.done, .done, .done, .done, .here, .ahead])
        } column: {
            FirstRunColumn("Photos") { StreamPicture(.photos()) } line: {
                FirstRunLine("Every photo and video, with when and where you took it. So your days have their pictures.")
            }
        } foot: {
            FirstRunFoot {
                Button("Allow") {}.buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
            } plain: {
                Button("Not now") {}.buttonStyle(.cockpit(.plain, fullWidth: true))
            }
        }
    }
    Specimen("Allow pressed: busy in place, through both of Location's asks, with no words between them; the note stands") {
        screen {
            StepMarks([.done, .here, .ahead, .ahead, .ahead, .ahead])
        } column: {
            FirstRunColumn("Location") { StreamPicture(.map()) } line: {
                FirstRunLine("Where you go, point by point. So your days show your places and the way between them.")
            }
        } foot: {
            FirstRunFoot(note: "iOS asks twice. Choose Allow While Using, then Change to Always Allow.") {
                Button("Allow") {}.buttonStyle(.cockpit(.primary, size: .large, busy: true, fullWidth: true))
            } plain: {
                Button("Not now") {}.buttonStyle(.cockpit(.plain, fullWidth: true)).allowsHitTesting(false)
            }
        }
    }
    Specimen("The note before the first Allow; Not now pressed: the plain dims in its own slot, apart from the primary") {
        screen {
            StepMarks([.done, .done, .done, .here, .ahead, .ahead])
        } column: {
            FirstRunColumn("Health") { StreamPicture(.health) } line: {
                FirstRunLine("Sleep, steps, heart and anything else you choose. So your days show how you slept and how you felt.")
            }
        } foot: {
            FirstRunFoot(note: "iOS shows a list. Turn on whatever you're happy for Lifestream to read.") {
                Button("Allow") {}.buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
            } plain: {
                Button("Not now") {}.buttonStyle(pressed(.cockpit(.plain, fullWidth: true)))
            }
        }
    }
    Specimen("Found: what the phone read; the same capsule says Allowed, calm, the plain gone from its slot") {
        screen {
            StepMarks([.done, .done, .done, .done, .here, .ahead])
        } column: {
            FirstRunColumn("Photos") { StreamPicture(.photos(standIns(8))) } line: {
                FirstRunLine("22,700 photos · back to 2014.", kind: .found)
            }
        } foot: {
            FirstRunFoot(done: "Allowed") {
                Button("Allow") {}.buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
            } plain: {
                Button("Not now") {}.buttonStyle(.cockpit(.plain, fullWidth: true))
            }
        }
    }
    Specimen("Pair: the Mac joined; the same capsule says Paired") {
        screen {
            StepMarks([.here, .ahead, .ahead, .ahead, .ahead, .ahead])
        } column: {
            FirstRunColumn("Paired") { PairPicture(joined: true) } line: { EmptyView() }
        } foot: {
            FirstRunFoot(done: "Paired") {
                Button("Pair") {}.buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
            } plain: {
                Button("Pair later") {}.buttonStyle(.cockpit(.plain, fullWidth: true))
            }
        }
    }
    Specimen("Refused: what it costs, Continue, the way to change it, and the note") {
        screen {
            StepMarks([.done, .done, .here, .ahead, .ahead, .ahead])
        } column: {
            FirstRunColumn("Motion") { StreamPicture(.motion) } line: {
                FirstRunLine("Off. Your days will miss how you moved.", kind: .state)
            }
        } foot: {
            FirstRunFoot(note: "iOS closes Lifestream when you change this. It opens back here.") {
                Button("Continue") {}.buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
            } plain: {
                Button("Turn on in Settings") {}.buttonStyle(.cockpit(.plain, fullWidth: true))
            }
        }
    }
    Specimen("Done on the river's band: the marks as the run left them, the column in the middle of its room, Start") {
        screen(centred: true, band: true) {
            StepMarks([.done, .done, .done, .done, .done, .past])
        } column: {
            FirstRunColumn("This iPhone records") { EmptyView() } line: {
                FirstRunLine("Anything off can be turned on here, or later in Connectors.")
            } below: {
                VStack(alignment: .leading, spacing: Cockpit.Space.s6) {
                    Card(group: true) {
                        let streams: [(String, Cockpit.Icon, String)] = [
                            ("Location", .location, "On"), ("Motion", .walk, "On"), ("Health", .health, "On"),
                            ("Photos", .photos, "On"),
                        ]
                        ForEach(Array(streams.enumerated()), id: \.offset) { _, stream in
                            ListRow(stream.0, meta: stream.2, leading: .symbol(stream.1)) { EmptyView() }
                        }
                        ListRow("Contacts", meta: "Not now", signal: .idle, leading: .symbol(.person), separator: false,
                                control: .act("Allow", busy: false, perform: {})) { EmptyView() }
                    }
                    Card(group: true) {
                        ListRow("Your Mac", meta: "Paired", leading: .symbol(.workMac), separator: false) { EmptyView() }
                    }
                }
            }
        } foot: {
            FirstRunFoot {
                Button("Start") {}.buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
            }
        }
    }
    Specimen("Welcome on the river's band: the mark in the picture's place, Set up, the privacy policy") {
        screen(band: true) {
            EmptyView()
        } column: {
            FirstRunColumn("Welcome to Lifestream") {
                LogoMark().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
            } line: {
                FirstRunLine("Everything about you, gathered into one stream and kept on your Mac. This iPhone adds where you go, how you move, your health and your photos.")
            }
        } foot: {
            FirstRunFoot {
                Button("Set up") {}.buttonStyle(.cockpit(.primary, size: .large, fullWidth: true))
            } plain: {
                Button("Privacy policy") {}.buttonStyle(.cockpit(.plain, size: .small, fullWidth: true))
            }
        }
    }
}
#endif
