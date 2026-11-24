#if os(macOS)
import SwiftUI
@testable import Cockpit


private struct Land<Content: View>: View {
    let height: CGFloat
    @ViewBuilder let content: Content

    var body: some View {
        ZStack { content }
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .background(MapGround.land)
            .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous))
    }
}

private struct Named<Mark: View>: View {
    let name: String
    var faded = false
    var strong = false
    @ViewBuilder let mark: Mark

    var body: some View {
        VStack(spacing: MapMarks.nameGap) {
            MapName(name, faded: faded, strong: strong)
            mark
        }
    }
}

@MainActor let mapMarksSheet = Sheet("map-marks") {
    Specimen("Places by their hours: 1, 10, 100, 1,000h; one not visited in six months") {
        Land(height: 96) {
            HStack(alignment: .bottom, spacing: Cockpit.Space.s5) {
                Named(name: "Kiln Coffee") { PlaceDisc(diameter: MapMarks.diameter(hours: 1)) }
                Named(name: "Civic Theatre") { PlaceDisc(diameter: MapMarks.diameter(hours: 10)) }
                Named(name: "Climbing") { PlaceDisc(diameter: MapMarks.diameter(hours: 100)) }
                Named(name: "Home") { PlaceDisc(diameter: MapMarks.diameter(hours: 1_000)) }
                Named(name: "Old Office", faded: true) { PlaceDisc(diameter: MapMarks.diameter(hours: 300), faded: true) }
            }
        }
    }
    Specimen("A spot to name; the open spot (a naming card's, a hidden spot's) in its reach; the person, alone and at a place") {
        Land(height: 80) {
            HStack(spacing: Cockpit.Space.s8) {
                SpotRing()
                ZStack {
                    ReachCircle(diameter: 60)
                    SpotRing(open: true)
                }
                HereMark()
                Named(name: "Northside Climbing") {
                    PlaceDisc(diameter: MapMarks.diameter(hours: 140)).overlay { HereMark() }
                }
            }
        }
    }
    Specimen("Around a circle being set: a spot and a stay it takes in, lit; a spot and a stay it leaves out; another place's circle it overlaps, quiet") {
        Land(height: 80) {
            HStack(spacing: Cockpit.Space.s8) {
                SpotRing(lit: true)
                SpotRing()
                StayDot(lit: true)
                StayDot()
                ZStack {
                    ReachCircle(diameter: 60, quiet: true)
                    PlaceDisc(diameter: MapMarks.diameter(hours: 30), faded: true)
                }
            }
        }
    }
    Specimen("Places just named, lit among the others (the naming's finish)") {
        Land(height: 80) {
            HStack(spacing: Cockpit.Space.s8) {
                PlaceDisc(diameter: MapMarks.diameter(hours: 40))
                PlaceDisc(diameter: MapMarks.diameter(hours: 1), lit: true)
                PlaceDisc(diameter: MapMarks.diameter(hours: 300), faded: true)
                PlaceDisc(diameter: MapMarks.diameter(hours: 2), lit: true)
            }
        }
    }
    Specimen("Overlapping places as one: 3, 12, 140") {
        Land(height: 72) {
            HStack(spacing: Cockpit.Space.s8) {
                ClusterDisc(count: 3)
                ClusterDisc(count: 12)
                ClusterDisc(count: 140)
            }
        }
    }
    Specimen("Cities by their places: 2, 7, 18 (the one you are in)") {
        Land(height: 96) {
            HStack(alignment: .bottom, spacing: Cockpit.Space.s8) {
                Named(name: "Westmere") { PlaceDisc(diameter: MapMarks.diameter(places: 2)) }
                Named(name: "Northfield") { PlaceDisc(diameter: MapMarks.diameter(places: 7)) }
                Named(name: "Bayview", strong: true) {
                    PlaceDisc(diameter: MapMarks.diameter(places: 18)).overlay { HereMark() }
                }
            }
        }
    }
    Specimen("A place's reach, its disc and the person inside it") {
        Land(height: 150) {
            ReachCircle(diameter: 120)
            PlaceDisc(diameter: MapMarks.diameter(hours: 140))
            HereMark().offset(x: 14, y: 12)
        }
    }
}

@MainActor private func placesList(open: Bool) -> some View {
    Card("Bayview", count: 18, open: {}, group: true) {
        ListRow("Northside Climbing", here: true, meta: "1h 40m today", mono: true, action: {})
        ListRow("Harbour Home", meta: "7h 50m today", mono: true, action: {})
        ListRow("Kiln Coffee", meta: "Tuesday", mono: true, action: {})
        FoldRow("Visited once", count: 11, open: .constant(open), separator: open)
        if open {
            ListRow("Lantern Noodle Bar", meta: "22 Aug", mono: true, action: {})
            ListRow("Harbour Clinic", meta: "2 Oct", mono: true, separator: false, action: {})
        }
    }
}

@MainActor private func placesTitle() -> some View {
    HStack(alignment: .capCentre, spacing: Cockpit.Space.s3) {
        Text("Places").cockpit(.title1).foregroundStyle(Cockpit.Color.text).capCentre(.title1)
        Spacer(minLength: 0)
        InvitationPill(count: 12, words: "to name", label: "12 places to name", action: {}) { SpotRing(diameter: MapMarks.legend) }
    }
}

@MainActor let mapSheetSheet = Sheet("map-sheet", ios: 390, mac: 420, hosted: true) {
    ForEach([SheetRest.middle, .low], id: \.self) { rest in
        Specimen(rest == .middle ? "Middle: the map above, the list under it" : "Low: the title alone") {
            ZStack(alignment: .top) {
                MapGround.land
                MapSheet(rest: .constant(rest), page: 0) {
                    placesTitle()
                } head: {
                    VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
                        SearchField(text: .constant(""), placeholder: "Search places")
                        Views("Places", options: [.init("Places", id: 0, count: 40), .init("Cities", id: 1, count: 6),
                                                  .init("Trips", id: 2, count: 14)], selection: .constant(0))
                    }
                } content: {
                    placesList(open: false)
                }
            }
            .frame(height: 620)
            .clipShape(RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous))
        }
    }
}

@MainActor let invitationPillSheet = Sheet("invitation-pill") {
    Specimen("Beside the title, centred on its capitals") { placesTitle() }
    Specimen("Pressed (iPhone) or hovered (Mac)") {
        var pill = InvitationPill(count: 12, words: "to name", label: "12 places to name", action: {}) { SpotRing(diameter: MapMarks.legend) }
        pill.forced = true
        return pill
    }
    Specimen("A count of hundreds") {
        InvitationPill(count: 154, words: "to name", label: "154 places to name", action: {}) { SpotRing(diameter: MapMarks.legend) }
    }
}

@MainActor let foldRowSheet = Sheet("fold-row") {
    Specimen("Closed, at the end of a city") { placesList(open: false) }
    Specimen("Open: its places follow it") { placesList(open: true) }
    Specimen("Pressed (iPhone) or hovered (Mac)") {
        Card(group: true) { pressedFold }
    }
}

@MainActor private var pressedFold: some View {
    var fold = FoldRow("Visited once", count: 11, open: .constant(false))
    fold.forced = .pressed
    return fold
}
#endif
