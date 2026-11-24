import Cockpit
import SwiftUI

struct LockedCover: View {
    @ObservedObject var needs: NeedsModel
    let opened: () -> Void

    var body: some View {
        ZStack {
            if needs.cover != nil { LockedPage(needs: needs) }
        }
        .onChange(of: needs.cover == nil) { if needs.cover == nil { opened() } }
    }
}

struct LockedPage: View {
    static let title = "Lifestream is locked"
    static let notKeptTitle = "This Mac couldn't keep Lifestream's key"
    static let notKeptWords = "Lifestream is open, but nothing can read it until this Mac keeps its key."
    static let opening = "Opening Lifestream…"
    static let openingWaits = "It goes on once Lifestream answers on this Mac."
    static let allowWords = "This Mac's Keychain holds Lifestream's key. macOS will ask for your Mac's login password: choose Always Allow, or it asks again next time."
    static let keyWords = "Type your recovery key to unlock Lifestream on this Mac."
    static let instead = "Use your recovery key instead"

    @ObservedObject var needs: NeedsModel
    @State private var typed = ""
    @State private var withKey = false

    enum Face: Equatable {
        case opening(need: String?), notKept(String), allow, key
    }

    static func face(_ cover: NeedsModel.Cover?, withKey: Bool) -> Face {
        switch cover {
        case .opening(let need)?: return .opening(need: need)
        case .notKept(let why)?: return .notKept(why)
        case .locked(allow: true)? where !withKey: return .allow
        case .locked?, nil: return .key
        }
    }

    static func title(_ face: Face) -> String {
        if case .notKept = face { return notKeptTitle }
        return title
    }

    var body: some View {
        let face = Self.face(needs.cover, withKey: withKey)
        VStack(alignment: .leading, spacing: Cockpit.Space.s4) {
            Text(Self.title(face)).cockpit(.title2).foregroundStyle(Cockpit.Color.text).accessibilityAddTraits(.isHeader)
            switch face {
            case .opening(let need):
                HStack(spacing: Cockpit.Space.s2) {
                    ProgressView().controlSize(.small)
                    Text(Self.opening).quiet(.body)
                }
                Text(need ?? Self.openingWaits).quiet(.body)
            case .notKept(let why):
                Text(Self.notKeptWords).quiet(.body)
                Text(why).quiet(.body)
                Button("Try again") { needs.keepAgain() }.buttonStyle(.cockpit(.primary)).keyboardShortcut(.defaultAction)
            case .allow:
                if let why = needs.lockedWhy { Text(why).quiet(.body) }
                Text(Self.allowWords).quiet(.body)
                if let refusal = needs.refusals[Need.allow.id] { InPlaceLine(refusal) }
                HStack(spacing: Cockpit.Space.s2) {
                    Button("Allow") { needs.allow() }.buttonStyle(.cockpit(.primary)).keyboardShortcut(.defaultAction)
                        .disabled(needs.working.contains(Need.allow.id))
                    Button(Self.instead) { withKey = true }.buttonStyle(.cockpit(.plain))
                }
            case .key:
                if let why = needs.lockedWhy { Text(why).quiet(.body) }
                Text(Self.keyWords).quiet(.body)
                if let opens = KeyName.opensWith(needs.vault) { Text(opens).quiet(.body) }
                Field("Recovery key", text: $typed, secure: true, error: needs.refusals[Need.unlock.id])
                    .disabled(needs.working.contains(Need.unlock.id))
                Button("Unlock") { needs.unlock(typed) }.buttonStyle(.cockpit(.primary)).keyboardShortcut(.defaultAction)
                    .disabled(typed.isEmpty || needs.working.contains(Need.unlock.id))
            }
        }
        .frame(maxWidth: 560, alignment: .leading)
        .padding(Cockpit.Space.s8)
        .padding(.top, DashboardFailure.clear)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .groundColor(Cockpit.Color.canvas)
        .onChange(of: needs.opening) { if needs.opening { typed = "" } }
        .onDisappear { typed = "" }
    }
}
