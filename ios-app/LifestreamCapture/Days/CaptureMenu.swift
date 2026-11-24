import Cockpit
import SwiftUI

struct CaptureMenu: View {
    var slot = false
    @Environment(\.voiceNotes) private var voiceNotes

    var body: some View {
        Menu {
            Button {
                voiceNotes?.start()
            } label: {
                Label { Text("Voice note") } icon: { Image(icon: .voiceNote, size: .md) }
            }
            .accessibilityIdentifier("capture.menu.voice")
            Button {
                AppNavigation.shared.present(.camera)
            } label: {
                Label { Text("Photo") } icon: { Image(icon: .photo, size: .md) }
            }
            .accessibilityIdentifier("capture.menu.photo")
            Button {
                AppNavigation.shared.present(.notes(.newNote))
            } label: {
                Label { Text("Note") } icon: { Image(icon: .note, size: .md) }
            }
            .accessibilityIdentifier("capture.menu.note")
            Button {
                AppNavigation.shared.checkInRoute = CheckInRoute(destination: .moment)
            } label: {
                Label { Text("Check-in") } icon: { Image(icon: .checkIn, size: .md) }
            }
            .accessibilityIdentifier("capture.menu.checkin")
            Divider()
            Button {
                AppNavigation.shared.present(.notes(.folders))
            } label: {
                Label { Text("All notes") } icon: { Image(icon: .folder, size: .md) }
            }
            .accessibilityIdentifier("capture.menu.notes")
        } label: {
            if slot { PlusLabel().foregroundStyle(Cockpit.Color.text).barSlot() } else { PlusLabel() }
        }
        .accessibilityIdentifier("capture.open")
    }
}

private struct PlusLabel: View {
    var body: some View {
        Icon(.add, size: .lg, label: "Capture")
    }
}

extension View {
    func captureMenu() -> some View {
        toolbar {
            ToolbarItem(placement: .topBarTrailing) { CaptureMenu() }
        }
    }
}

extension EnvironmentValues {
    @Entry var voiceNotes: VoiceRecordController?
}
