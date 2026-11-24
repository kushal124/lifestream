#if os(macOS)
import AppKit
import SwiftUI
@testable import Cockpit

@MainActor func drawnFace(_ n: Int) -> Image {
    let grounds: [Color] = [.init(white: 0.38), .init(red: 0.43, green: 0.41, blue: 0.38), .init(red: 0.33, green: 0.37, blue: 0.42),
                            .init(red: 0.37, green: 0.42, blue: 0.37), .init(red: 0.42, green: 0.39, blue: 0.44), .init(white: 0.45)]
    let skins: [Color] = [.init(red: 0.80, green: 0.60, blue: 0.45), .init(red: 0.55, green: 0.36, blue: 0.24),
                          .init(red: 0.93, green: 0.78, blue: 0.66), .init(red: 0.68, green: 0.46, blue: 0.32),
                          .init(red: 0.45, green: 0.29, blue: 0.20), .init(red: 0.87, green: 0.70, blue: 0.56)]
    let hairs: [Color] = [.init(white: 0.15), .init(red: 0.30, green: 0.20, blue: 0.14), .init(white: 0.1),
                          .init(red: 0.55, green: 0.40, blue: 0.25), .init(white: 0.7), .init(red: 0.40, green: 0.28, blue: 0.18)]
    let person = n >= 6 ? 0 : n
    let ground = grounds[n % grounds.count]
    let tilt = n >= 6 ? Double([-7, 5, -3, 8, -9, 4][n - 6]) : 0
    let zoom = n >= 6 ? [1.08, 1.18, 1.0, 1.12, 1.05, 1.2][n - 6] : 1.0
    let drawing = ZStack {
        ground
        ZStack {
            Ellipse().fill(Color(white: 0.25)).frame(width: 120, height: 70).offset(y: 70)
            Rectangle().fill(skins[person]).frame(width: 26, height: 30).offset(y: 30)
            Ellipse().fill(hairs[person]).frame(width: 74, height: 84).offset(y: -9)
            Ellipse().fill(skins[person]).frame(width: 64, height: 78)
            Ellipse().fill(hairs[person]).frame(width: 60, height: 26).offset(y: -30)
            HStack(spacing: 18) {
                Circle().fill(Color(white: 0.12)).frame(width: 7, height: 7)
                Circle().fill(Color(white: 0.12)).frame(width: 7, height: 7)
            }
            .offset(y: 2)
            Capsule().fill(Color(white: 0.2).opacity(0.6)).frame(width: 18, height: 3).offset(y: 22)
        }
        .rotationEffect(.degrees(tilt))
        .scaleEffect(zoom)
    }
    .frame(width: 160, height: 160)
    .clipped()
    let renderer = ImageRenderer(content: drawing)
    renderer.scale = 2
    return renderer.nsImage.map { Image(nsImage: $0) } ?? Image(systemName: "person")
}

@MainActor private func crop(_ n: Int, mode: FaceCrop.Mode = .open, on: Bool = false, forced: RowHighlight? = nil,
                             focused: Bool = false) -> FaceCrop {
    var crop = FaceCrop(drawnFace(n), label: "Photo", mode: mode, on: on, action: {})
    crop.forced = forced
    crop.focused = focused
    return crop
}

@MainActor let personFaceSheet = Sheet("person-face") {
    Specimen("A photo · sm 24 · md 32 · row 36 · tile 56 · head 72") {
        HStack(alignment: .center, spacing: 16) {
            PersonFace("Sam Rivera", photo: drawnFace(0), size: .sm)
            PersonFace("Sam Rivera", photo: drawnFace(0), size: .md)
            PersonFace("Sam Rivera", photo: drawnFace(0), size: .row)
            PersonFace("Sam Rivera", photo: drawnFace(0), size: .tile)
            PersonFace("Sam Rivera", photo: drawnFace(0), size: .head)
        }
    }
    Specimen("No photo: the monogram") {
        HStack(alignment: .center, spacing: 16) {
            PersonFace("Dana Okafor", size: .sm)
            PersonFace("Dana Okafor", size: .md)
            PersonFace("Dana Okafor", size: .row)
            PersonFace("Dana Okafor", size: .tile)
            PersonFace("Dana Okafor", size: .head)
        }
    }
    Specimen("The camera badge: the face takes a press that chooses their photo · tile 56 · head 72") {
        HStack(alignment: .center, spacing: 16) {
            PersonFace("Sam Rivera", photo: drawnFace(0), size: .tile, badge: true)
            PersonFace("Dana Okafor", size: .tile, badge: true)
            PersonFace("Sam Rivera", photo: drawnFace(0), size: .head, badge: true)
            PersonFace("Dana Okafor", size: .head, badge: true)
        }
    }
    Specimen("A name with no letter in it · no name yet") {
        HStack(alignment: .center, spacing: 16) {
            PersonFace("+1 555 000 0014", size: .row)
            PersonFace("+1 555 000 0014", size: .tile)
            PersonFace(nil, size: .row)
            PersonFace(nil, size: .tile)
        }
    }
    Specimen("Not read yet: its own circle") {
        HStack(alignment: .center, spacing: 16) {
            PersonFace("Sam Rivera", photo: drawnFace(0), size: .sm)
            PersonFace("Sam Rivera", photo: drawnFace(0), size: .md)
            PersonFace("Sam Rivera", photo: drawnFace(0), size: .row)
            PersonFace("Sam Rivera", photo: drawnFace(0), size: .tile)
            PersonFace("Sam Rivera", photo: drawnFace(0), size: .head)
        }
        .reading(true)
        .environment(\.skeletonForced, 0.3)
    }
}

@MainActor let faceCropSheet = Sheet("face-crop", ios: 390, mac: 520) {
    let side: CGFloat = 72
    Specimen("Open · hover · focus") {
        HStack(spacing: 12) {
            crop(1).frame(width: side)
            crop(1, forced: .hover).frame(width: side)
            crop(1, focused: true).frame(width: side)
        }
    }
    Specimen("Out · hover: the ✕ · moved out") {
        HStack(spacing: 12) {
            crop(3, mode: .out).frame(width: side)
            crop(3, mode: .out, forced: .hover).frame(width: side)
            crop(3, mode: .out, on: true).frame(width: side)
        }
    }
    Specimen("Choose: the photo · focus on it") {
        HStack(spacing: 12) {
            crop(2, mode: .choose, on: true).frame(width: side)
            crop(2, mode: .choose, on: true, focused: true).frame(width: side)
            crop(2, mode: .choose).frame(width: side)
        }
    }
    Specimen("No crop in the home · not read yet") {
        HStack(spacing: 12) {
            FaceCrop(nil, label: "Photo").frame(width: side)
            crop(1).frame(width: side).reading(true).environment(\.skeletonForced, 0.3)
        }
    }
}

@MainActor let moveAndScaleSheet = Sheet("move-and-scale", ios: 390, mac: 680) {
    if let wide = StandInPhoto.image(0, size: 1200, height: 900), let tall = StandInPhoto.image(0, size: 900, height: 1200),
       let small = StandInPhoto.image(0, size: 150, height: 120) {
        let specimens: [(String, CGImage, MoveAndScale.Square?)] = [
            ("At rest: the square across the shorter side, centred", wide, nil),
            ("A portrait picture: on iPhone it shows beyond the square, above and below", tall, nil),
            ("Scaled in on the face", wide, .init(x: 340, y: 130, side: 520)),
            ("Moved to the picture’s corner: held there", wide, .init(x: -200, y: -80, side: 640)),
            ("At the bound: a square of 160 pixels, held there", wide, .init(x: 520, y: 240, side: 100)),
            ("A picture under 160 on its shorter side: taken whole, no scale", small, nil),
        ]
        ForEach(specimens.indices, id: \.self) { at in
            Specimen(specimens[at].0) {
                MoveAndScaleSpecimen(picture: specimens[at].1, start: specimens[at].2)
            }
        }
    }
}

private struct MoveAndScaleSpecimen: View {
    let picture: CGImage
    let start: MoveAndScale.Square?
    @Environment(\.cockpitPlatform) private var platform

    var body: some View {
        MoveAndScale(picture, start: start, cancel: {}, use: { _ in })
            .frame(height: platform == .ios ? 640 : nil)
    }
}

@MainActor private func onCard<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: NameRow.gap) { content() }
        .padding(Cockpit.Space.s4)
        .background(RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous).fill(Cockpit.Color.surface))
        .cockpitShadow(Cockpit.Shadow.edge, in: RoundedRectangle(cornerRadius: Cockpit.Radius.lg, style: .continuous))
}

@MainActor let fieldRowSheet = Sheet("field-row", ios: 390, mac: 440, hosted: true) {
    Specimen("Filled · its source at its end, while it holds the home’s words") {
        onCard {
            FieldRow("Name", text: .constant("Sam"), placeholder: "What you call them")
            FieldRow("Full name", text: .constant("Sam Rivera"), source: "WhatsApp · 3 mails")
        }
    }
    Specimen("Empty: its placeholder · lit: the edge in here") {
        onCard {
            FieldRow("Relationship", text: .constant(""), placeholder: "Mother, friend from college, dentist")
            set(FieldRow("Name", text: .constant("Mom")), \.forcedLit, true)
        }
    }
    Specimen("Changed: the source gone · a long source, cut at its end") {
        onCard {
            FieldRow("Full name", text: .constant("Samuel Rivera"), source: "WhatsApp · 3 mails", sourced: false)
            FieldRow("Full name", text: .constant("Sam Rivera"), source: "WhatsApp, iMessage and Mail · 212 mails")
        }
    }
    Specimen("The words typed keep their width: a long name leaves its source no room") {
        onCard {
            FieldRow("Full name", text: .constant("Alexandra Okafor-Lindqvist"), source: "WhatsApp · 3 mails")
        }
    }
    Specimen("The menu variant: its value and its caret · open · pressed") {
        onCard {
            FieldRow("Kind", value: "A person") {}
            FieldRow("Kind", value: "AI", open: true) {}
            set(FieldRow("Kind", value: "A person") {}, \.forced, .pressed)
        }
    }
    Specimen("Disabled, while its card or sheet saves: its words step down") {
        onCard {
            FieldRow("Name", text: .constant("Sam")).disabled(true)
            FieldRow("Kind", value: "A person") {}.disabled(true)
        }
    }
    Specimen("Not read yet: the label stands") {
        onCard { FieldRow("Name", text: .constant("")).disabled(true) }
    }
    OnPhone {
        Specimen("Accessibility size (AX3): the label over its words, the source under them") {
            onCard {
                FieldRow("Full name", text: .constant("Sam Rivera"), source: "WhatsApp · 3 mails")
                FieldRow("Relationship", text: .constant(""), placeholder: "Friend from college", capitalizesWords: false)
                FieldRow("Kind", value: "An automated sender") {}
            }
            .environment(\.dynamicTypeSize, .accessibility3)
        }
    }
}

@MainActor let nameRowCardSheet = Sheet("name-row-card", ios: 390, mac: 440) {
    Specimen("The tick: empty · ticked · on a photo, empty · ticked") {
        HStack(spacing: 16) {
            Tick(on: false)
            Tick(on: true)
            Tick(on: false, photo: true).padding(4).background(Color(white: 0.45))
            Tick(on: true, photo: true).padding(4).background(Color(white: 0.45))
        }
    }
    Specimen("Theirs: an icon lead, its × on the lit row · lit") {
        onCard {
            NameRow("+1 555 000 0001", line: "Contact card", lead: .icon(.call), end: .remove("Remove") {}) {}
            NameRow("WhatsApp · hidden number", line: "WhatsApp pairs it with +1 555 000 0001", lead: .icon(.message),
                    end: .remove("Remove") {}, lit: true) {}
        }
    }
    Specimen("A suggestion with the round tick: not ticked · ticked · lit") {
        onCard {
            NameRow("sam.rivera@example.com", line: "Signed “Sam Rivera” · 14 mails", lead: .icon(.mail),
                    end: .tick(false) {}) {}
            NameRow("A face in your photos", line: "Not named yet · 198 photos", lead: .crop(drawnFace(0)),
                    end: .tick(true) {}) {}
            NameRow("Samuel R.", line: "Same person? · Both named Sam Rivera", lead: .face("Samuel R.", photo: nil),
                    end: .tick(true) {}, lit: true) {}
        }
    }
    Specimen("Added by you · a quiet row with its caret") {
        onCard {
            NameRow("“Dana O.” in your photos", line: "Face · added by you", lead: .face("Dana O.", photo: drawnFace(1)),
                    end: .tick(true) {}, added: true) {}
            NameRow("Mark their face", line: "Faces you named, and faces not named yet", lead: .ring(.photo), quiet: true) {}
        }
    }
    Specimen("Hover (Mac): the fainter fill, the × shown · pressed (iPhone)") {
        onCard {
            set(NameRow("+1 555 000 0001", line: "Contact card", lead: .icon(.call), end: .remove("Remove") {}) {}, \.forced, .hover)
            set(NameRow("sam.rivera@example.com", line: "Signed “Sam Rivera” · 14 mails", lead: .icon(.mail),
                        end: .tick(false) {}) {}, \.forced, .pressed)
        }
    }
    OnPhone {
        Specimen("iPhone: a tick row is a toggle, no light; Theirs is no button and draws no ×, removed by the list’s swipe") {
            onCard {
                NameRow("Birthday 14 August?", line: "From your messages", lead: .icon(.calendarEvent), end: .tick(false) {}) {}
                NameRow("+1 555 000 0001", line: "Contacts", lead: .icon(.call), end: .remove("Remove") {}) {}
            }
        }
        Specimen("iPhone, a form's grid: a key on the label column, the value on the fields' edge, another source at the end; a suggestion's Add, and taken") {
            onCard {
                NameRow("+1 555 000 0001", line: "From Contacts", lead: .key("Phone"), end: .remove("Remove") {}) {}
                NameRow("Number hidden", line: "", lead: .key("WhatsApp"), end: .remove("Remove") {}) {}
                NameRow("14 August?", line: "From your messages", lead: .key("Suggested"), end: .add(false) {}) {}
                NameRow("Dana O.", line: "A face you named · Same person?", lead: .key("Face"), end: .add(true) {}) {}
            }
        }
        Specimen("Disabled, while its sheet saves · accessibility size (AX3)") {
            onCard {
                NameRow("+1 555 000 0014", line: "WhatsApp · same name", lead: .icon(.message), end: .tick(true) {}) {}.disabled(true)
                NameRow("sam.rivera@example.com", line: "Signed “Sam Rivera” · 14 mails", lead: .icon(.mail), end: .tick(false) {}) {}
                    .environment(\.dynamicTypeSize, .accessibility3)
            }
        }
    }
    Specimen("Not read yet: two") {
        onCard {
            NameRow("sam.rivera@example.com", line: "Signed “Sam Rivera” · 14 mails", lead: .icon(.mail), end: .tick(false) {}) {}
            NameRow("A face in your photos", line: "Not named yet · 198 photos", lead: .icon(.photo), end: .tick(false) {}) {}
        }
        .reading(true)
        .environment(\.skeletonForced, 0.3)
    }
}

@MainActor let cardChipSheet = Sheet("card-chip", ios: 390, mac: 440) {
    Specimen("The quiet pill · its menu open · hover") {
        HStack(spacing: 6) {
            CardChip("Not a person", kind: .ask(open: false)) {}
            CardChip("Not a person", kind: .ask(open: true)) {}
            set(CardChip("Not a person", kind: .ask(open: false)) {}, \.forced, .hover)
        }
    }
    Specimen("The home’s suspicion: ticked · not") {
        VStack(alignment: .leading, spacing: 6) {
            CardChip("AI", kind: .tick(true, why: "Replies within 20 s · 91% of 212 replies")) {}
            CardChip("A business", kind: .tick(false, why: "Listed as a business on WhatsApp")) {}
        }
    }
    Specimen("A business only offered: its strongest sign") {
        VStack(alignment: .leading, spacing: 6) {
            CardChip("A business", kind: .tick(false, why: "Listed as a business on WhatsApp")) {}
            CardChip("A business", kind: .tick(false, why: "Named like a business you hear from")) {}
            CardChip("A business", kind: .tick(false, why: "Mail signed by several people")) {}
            CardChip("A business", kind: .tick(false, why: "A company, no person\u{2019}s name")) {}
        }
    }
    Specimen("A reason too long for the card, cut at its end") {
        CardChip("A business", kind: .tick(false, why: "Named like a business you hear from")) {}
            .frame(maxWidth: 220, alignment: .leading)
    }
    Specimen("What you said, or the home judged: a filled tag ending in ×, its words saying whose") {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: Cockpit.Space.s3) {
                CardChip("A business", kind: .tag) {}
                Text("The home thinks so").cockpit(.subhead).foregroundStyle(Cockpit.Color.textTertiary)
            }
            HStack(spacing: Cockpit.Space.s3) {
                CardChip("AI", kind: .tag) {}
                Text("You said so").cockpit(.subhead).foregroundStyle(Cockpit.Color.textTertiary)
            }
        }
    }
}

@MainActor let factChipSheet = Sheet("fact-chip", ios: 390, mac: 420) {
    Specimen("A birthday far off, then their profiles, each a link") {
        FactChips {
            FactChip("14 Aug", icon: .calendarEvent, label: "Birthday 14 August")
            FactChip("@person.a", icon: Cockpit.Icon(rawValue: "instagram"), label: "Instagram, @person.a") {}
            FactChip("person-a", icon: Cockpit.Icon(rawValue: "github"), label: "GitHub, person-a") {}
            FactChip("example.com", icon: Cockpit.Icon(rawValue: "web"), label: "Site, example.com/person-a") {}
        }
    }
    Specimen("Near · on the day") {
        FactChips {
            FactChip("Birthday in 3 days", icon: .calendarEvent)
            FactChip("Birthday today", icon: .calendarEvent)
        }
    }
    Specimen("A handle too long for the line; no glyph") {
        FactChips {
            FactChip("a-very-long-handle-of-someone-who-writes-code.example.com", label: "Site") {}
            FactChip("14 Aug")
        }
    }
    Specimen("Pressed (iPhone) or hovered (Mac)") {
        FactChips {
            pressedFact
        }
    }
    Specimen("Reading") {
        FactChips {
            FactChip("14 Aug", icon: .calendarEvent)
            FactChip("@person.a") {}
        }
        .reading(true)
        .environment(\.skeletonForced, 0.3)
    }
}

@MainActor private var pressedFact: some View {
    var chip = FactChip("@person.a", icon: Cockpit.Icon(rawValue: "instagram"), label: "Instagram, @person.a") {}
    chip.forced = .pressed
    return chip
}

#endif
