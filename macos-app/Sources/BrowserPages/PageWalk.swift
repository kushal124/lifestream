import Evidence
import Foundation

struct PageNode<Node> {
    let role: String?
    let title: String?
    let children: [Node]
}

protocol PageTree {
    associatedtype Node: Hashable
    func read(_ node: Node, title: Bool) -> PageNode<Node>?
    func url(_ node: Node) -> URL?
}

struct PageWalk<Tree: PageTree> {
    static var webArea: String { "AXWebArea" }
    static var nodeBudget: Int { 2000 }

    struct Outcome: Equatable {
        let page: BrowserPage
        let cause: PageUnknownCause?
        let provedNotPrivate: Bool
    }

    let tree: Tree
    let signal: PrivateWindowSignal
    let deadline: Double
    let now: () -> Double

    func read(_ window: Tree.Node, knownNotPrivate: Bool = false, document: URL? = nil) -> Outcome {
        if knownNotPrivate, let document { return page(document, proved: false) }
        var queue = [window]
        var head = 0
        var webArea: Tree.Node?
        while head < queue.count {
            guard head < Self.nodeBudget else { return unknown(.walkBudget) }
            guard now() < deadline else { return unknown(.walkDeadline) }
            let node = queue[head]
            head += 1
            guard let read = tree.read(node, title: !knownNotPrivate) else {
                return unknown(now() < deadline ? .controlsUnreadable : .walkDeadline)
            }
            if read.role == Self.webArea {
                if webArea == nil { webArea = node }
                if knownNotPrivate { break }
                continue
            }
            if !knownNotPrivate, signal.matches(role: read.role, title: read.title) {
                return Outcome(page: .privateWindow, cause: nil, provedNotPrivate: false)
            }
            queue.append(contentsOf: read.children)
        }
        let proved = !knownNotPrivate
        if let document { return page(document, proved: proved) }
        guard let webArea else { return unknown(.noWebArea, proved: proved) }
        guard now() < deadline else { return unknown(.walkDeadline, proved: proved) }
        guard let url = tree.url(webArea) else { return unknown(.urlUnreadable, proved: proved) }
        return page(url, proved: proved)
    }

    private func page(_ url: URL, proved: Bool) -> Outcome {
        guard let site = Site(page: url) else { return unknown(.pageWithoutHost, proved: proved) }
        return Outcome(page: .site(site), cause: nil, provedNotPrivate: proved)
    }

    private func unknown(_ cause: PageUnknownCause, proved: Bool = false) -> Outcome {
        Outcome(page: .unknown, cause: cause, provedNotPrivate: proved)
    }
}

struct NotPrivateWindows<Node: Hashable> {
    private var windows: Set<Node> = []
    let capacity: Int

    init(capacity: Int = 512) {
        self.capacity = max(1, capacity)
    }

    var count: Int { windows.count }

    func contains(_ window: Node) -> Bool { windows.contains(window) }

    mutating func insert(_ window: Node) {
        if windows.count >= capacity, !windows.contains(window) { windows.removeAll() }
        windows.insert(window)
    }

    mutating func keep(only listed: Set<Node>) {
        windows.formIntersection(listed)
    }
}

enum PageReading {
    static let transient: Set<PageUnknownCause> = [.walkDeadline, .controlsUnreadable, .noWebArea, .urlUnreadable]
    static let attempts = 2

    struct Read: Equatable {
        let page: BrowserPage
        let cause: PageUnknownCause?
    }

    static func read<Tree: PageTree>(_ window: Tree.Node, signal: PrivateWindowSignal, document: URL? = nil,
                                     title: String? = nil,
                                     memo: inout NotPrivateWindows<Tree.Node>, budget: Double,
                                     deadline stated: Double? = nil, until limit: Double? = nil,
                                     tree: (_ deadline: Double) -> Tree,
                                     now: @escaping () -> Double) -> Read {
        var titled = false
        if case .windowTitleEnding(let ending) = signal {
            guard let title else { return Read(page: .unknown, cause: .windowUnreadable) }
            guard !title.hasSuffix(ending) else { return Read(page: .privateWindow, cause: nil) }
            titled = true
        }
        var last = Read(page: .unknown, cause: .walkDeadline)
        for _ in 0..<(stated == nil ? attempts : 1) {
            let deadline = min(stated ?? now() + budget, limit ?? .infinity)
            guard now() < deadline else { return last }
            let outcome = PageWalk(tree: tree(deadline), signal: signal, deadline: deadline, now: now)
                .read(window, knownNotPrivate: titled || memo.contains(window), document: document)
            if outcome.provedNotPrivate { memo.insert(window) }
            last = Read(page: outcome.page, cause: outcome.cause)
            guard outcome.page == .unknown, let cause = outcome.cause, transient.contains(cause) else { return last }
        }
        return last
    }
}
