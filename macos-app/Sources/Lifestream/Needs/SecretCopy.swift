import AppKit

enum SecretCopy {
    static let lasts: TimeInterval = 90
    static let concealed = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
    static let transient = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

    typealias Later = @MainActor (TimeInterval, @escaping @MainActor () -> Void) -> Void

    static let wallClock: Later = { seconds, work in
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(seconds))
            work()
        }
    }

    @MainActor static func put(_ secret: String, on board: NSPasteboard, later: Later = wallClock) {
        board.clearContents()
        let item = NSPasteboardItem()
        item.setString(secret, forType: .string)
        item.setData(Data(), forType: concealed)
        item.setData(Data(), forType: transient)
        board.writeObjects([item])
        let copied = board.changeCount
        held = (board, copied)
        later(lasts) { clear(board, ifStill: copied) }
    }

    @MainActor private static var held: (board: NSPasteboard, count: Int)?

    @MainActor static func leaving() {
        guard let held else { return }
        clear(held.board, ifStill: held.count)
    }

    @MainActor private static func clear(_ board: NSPasteboard, ifStill copied: Int) {
        if board.changeCount == copied { board.clearContents() }
        if let held, held.board === board, held.count == copied { self.held = nil }
    }
}
