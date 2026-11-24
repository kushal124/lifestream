import Cockpit
import HomeLink
import LifestreamCaptureCore
import SwiftUI

struct StoragePage: View {
    let title: String
    @StateObject private var read = PageReading<HomeLink.Pages.Storage>(Self.key)
    @State private var unfolded = false
    @Environment(\.openConnectors) private var open

    init(title: String) {
        self.title = title
    }

    static let key = HomeLink.PageKey(HomeLink.Pages.Storage.route)
    static let counting: Duration = .seconds(3)
    static let lacks = "Pair this iPhone to see what Lifestream keeps."

    var body: some View {
        SheetPage(read.page?.title ?? title) {
            if let page = read.page {
                PageNote(drawn: read.drawn).padding(.horizontal, Cockpit.Space.s4)
                SheetPart(nil) {
                    CardRow(separator: false) { head(page) }
                }
                SheetPart(page.used, action: Self.folds(page) ? (unfolded ? page.fewer : page.more) : nil,
                          perform: { unfolded.toggle() }, actionIdentifier: "storage.fold") {
                    let uses = Self.shown(page.uses, unfolded: unfolded)
                    ForEach(uses.indices, id: \.self) { index in
                        use(uses[index], separator: index < uses.count - 1)
                    }
                }
                SheetPart(nil) {
                    SettingRow(page.keep.label, value: page.keep.size, line: page.keep.line, separator: false)
                        .accessibilityIdentifier("storage.keep")
                }
            } else if let failure = read.failure {
                ReadLack(failure, lacks: Self.lacks, words: PlacesWords.failure(failure))
                    .padding(.horizontal, Cockpit.Space.s4)
            } else {
                Loading(title, size: .inline).padding(.horizontal, Cockpit.Space.s4)
            }
        }
        .task { await read.read() }
        .task(id: read.page?.counted == false) {
            guard read.page?.counted == false else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: Self.counting)
                guard !Task.isCancelled else { return }
                await read.read()
            }
        }
        .readsAgain(failed: { read.failure }) { await read.read() }
        .accessibilityIdentifier("settings.page.storage")
    }

    private func head(_ page: HomeLink.Pages.Storage) -> some View {
        VStack(alignment: .leading, spacing: Cockpit.Space.s3) {
            Figure(page.figure, label: page.after)
                .accessibilityIdentifier("storage.figure")
            VStack(alignment: .leading, spacing: 2) {
                Text(page.disk)
                    .cockpit(Cockpit.Style.iosSubhead)
                    .foregroundStyle(Cockpit.Color.text)
                Text(Words.phrase(page.sentence))
                    .cockpit(Cockpit.Style.iosFootnote)
                    .foregroundStyle(Cockpit.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            DiskBar(page.bar.label, parts: Self.parts(page.bar), key: Self.key(page.bar), time: page.bar.left.isEmpty ? nil : page.bar.left)
                .accessibilityIdentifier("storage.bar")
        }
    }

    private func use(_ use: HomeLink.Pages.StorageUse, separator: Bool) -> some View {
        SettingRow(use.name, line: use.line.map { Words.phrase($0) }, separator: separator, lead: .tone(Self.tone(use.tone)),
                   opens: use.opens.map { id in { open(.connector(id)) } }) {
            SettingValue(use.size)
        }
        .accessibilityIdentifier("storage.use.\(use.id)")
    }

    static func folds(_ page: HomeLink.Pages.Storage) -> Bool {
        page.more != nil && page.uses.contains(where: \.folded)
    }

    static func shown(_ uses: [HomeLink.Pages.StorageUse], unfolded: Bool) -> [HomeLink.Pages.StorageUse] {
        unfolded ? uses : uses.filter { !$0.folded }
    }

    static func tone(_ tone: HomeLink.Pages.StorageTone) -> DiskBar.Tone {
        DiskBar.Tone(rawValue: tone.rawValue) ?? .other
    }

    static func parts(_ bar: HomeLink.Pages.StorageBar) -> [DiskBar.Part] {
        bar.parts.map { DiskBar.Part(id: $0.id, name: $0.name, tone: tone($0.tone), share: $0.share, size: $0.size) }
    }

    static func key(_ bar: HomeLink.Pages.StorageBar) -> [DiskBar.Key] {
        bar.key.map { DiskBar.Key(id: $0.id, name: $0.name, tone: tone($0.tone)) }
    }
}
