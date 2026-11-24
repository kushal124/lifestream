import Cockpit
import LifestreamCaptureCore
import SwiftUI

struct ContactsAddressBook: View {
    @ObservedObject private var shipper = AppRuntime.shared.shipping.shipper
    @ObservedObject private var permissions = PhoneNeeds.shared.permissions
    @EnvironmentObject private var model: CaptureAppModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var status: ContactsStatus?

    var body: some View {
        SheetPart("Address book") {
            SettingRow("Last read", value: status?.lastRead.flatMap(CaptureTime.date(rfc3339:)).map { Words.ago($0) } ?? "Not yet",
                       problem: status?.error)
            SettingRow("Contacts", value: status?.contacts.map { Words.count($0) } ?? "Not yet")
            SettingRow("Contact photos", value: keptPhotos, line: "Kept on this iPhone until Lifestream has them", separator: false)
        }
        .task(id: shipper.running) { await refresh() }
        .onChange(of: permissions.rows) { Task { await refresh() } }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await refresh() } }
        }
    }

    private var keptPhotos: String {
        guard let kept = status?.photosKept, kept > 0 else { return "None" }
        return Words.count(kept, "photo") + Words.dot
            + ByteCountFormatter.string(fromByteCount: Int64(clamping: status?.photoBytesKept ?? 0), countStyle: .file)
    }

    private func refresh() async { status = await model.runtime.contactsRecorder.status() }
}
