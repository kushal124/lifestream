import BrowserPages
import Evidence
import Foundation

protocol InputChunkWriter: AnyObject {
    func chunkOpened(at: Date, layout: String)
    func appAdded(_ index: Int, name: String)
    func eventFinished(_ event: InputEvent)
    func siteAdded(_ index: Int, host: String)
    func activityCounted(_ activity: InputActivity)
    func lostCounted(_ total: Int)
    func chunkClosed(_ chunk: InputChunk?)
}

protocol InputElementLookups: AnyObject {
    func request(_ id: Int, _ target: InputLookupTarget, deadline: Double)
}

enum InputLookupTarget: Equatable, Sendable {
    case focus(pid: Int32, app: String, modes: RecordingModes)
    case position(pid: Int32, app: String, x: Double, y: Double)
    case page(pid: Int32, app: String)
}

enum InputElementLookup: Equatable, Sendable {
    case found(InputElementAttributes, action: InputElementAttributes?)
    case failed(InputLookupError)
}

struct InputOpeningState: Equatable, Sendable {
    var inputMonitoring: Bool
    var accessibility: Bool
    var screenLocked = false
    var onConsole = true
    var secureInput = false
    var layout: String
    var frontmost: (pid: Int32, name: String)?

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.inputMonitoring == rhs.inputMonitoring && lhs.accessibility == rhs.accessibility
            && lhs.screenLocked == rhs.screenLocked && lhs.onConsole == rhs.onConsole
            && lhs.secureInput == rhs.secureInput && lhs.layout == rhs.layout
            && lhs.frontmost?.pid == rhs.frontmost?.pid && lhs.frontmost?.name == rhs.frontmost?.name
    }
}

public struct InputTapRestart: Equatable, Sendable {
    public let at: Date
    public let reason: String
}

final class InputChunker {
    struct Limits {
        var capacity = 50_000
        var lookupTimeout = 0.150
        var waitingLookups = 8
        var movePeriod = 0.1
        var movePause = 0.5
        var scrollWindow = 0.1
        var burstGap = 0.5
    }

    static let loginWindow = "com.apple.loginwindow"

    private var modes: RecordingModes
    private let zone: TimeZone
    private let limits: Limits
    private let names: InputProcessNames
    private unowned let writer: InputChunkWriter
    private unowned let lookups: InputElementLookups

    private var arrivalPages: [Int32: InputPageRead] = [:]
    private var writtenPages: [Int32: InputPageRead] = [:]
    private var answerPages: [Int: InputPageRead] = [:]
    private var readingPages = Set<Int32>()
    private var frontmostPID: Int32?
    private var siteUnknownStated = false
    static let pageLimit = 64

    private var screenLocked = false
    private var onConsole = true
    private var frontmost: String?
    private var lockStated = false
    private var secureInput = false
    private var layout = "unknown"

    private var openAt: Date?
    private var boundary = Date.distantFuture
    private var lastUntil: Date?
    private var coalescing: Coalescing?
    private var lastWrittenMove: Date?
    private var lastWrittenMoveStream: Stream?
    private var lastKeyDown: Date?
    private var focusStale = true
    private var overflow = 0

    private var items: [Item] = []
    private var head = 0
    private var nextLookup = 0
    private var outstandingLookups = 0
    private var awaiting: [Int: (deadline: Double, requested: Double, pid: Int32?, pageRead: Bool)] = [:]
    private var answers: [Int: InputElement] = [:]
    private var answerOwners: [Int: String] = [:]

    private var chunk: OpenChunk?
    private var focusSecure = false
    private var hiddenCodes = Set<Int>()
    private var keyFocus: (target: String, owner: String)?
    private var withheldCodes = Set<Int>()

    private(set) var eventsWritten = 0
    private(set) var chunksWritten = 0
    private(set) var tapRestarts = 0
    private(set) var lastTapRestart: InputTapRestart?

    init(modes: RecordingModes, timeZone: TimeZone, limits: Limits = Limits(),
         names: InputProcessNames, writer: InputChunkWriter, lookups: InputElementLookups, after: Date? = nil) {
        lastUntil = after
        self.modes = modes
        self.zone = timeZone
        self.limits = limits
        self.names = names
        self.writer = writer
        self.lookups = lookups
    }

    func setModes(_ modes: RecordingModes) {
        self.modes = modes
    }

    var isDrained: Bool { head == items.count && coalescing == nil }
    var nextLookupDeadline: Double? { awaiting.values.map(\.deadline).min() }


    func open(at instant: Date, state: InputOpeningState) {
        screenLocked = state.screenLocked
        onConsole = state.onConsole
        secureInput = state.secureInput
        layout = state.layout
        if let frontmost = state.frontmost {
            names.remember(frontmost.pid, frontmost.name)
            self.frontmost = frontmost.name
            frontmostPID = frontmost.pid
        }
        let at = max(UTCInstant.millisecond(instant), lastUntil ?? .distantPast)
        openChunk(at: at)
        push(.event(Pending(instant: at, draft: Draft(.logStart(inputMonitoring: state.inputMonitoring,
                                                               accessibility: state.accessibility)))))
        lockStated = isLocked
        if lockStated { marker(.locked(on: true), at: at) }
        if secureInput { marker(.secureInput(on: true), at: at) }
        restateSiteUnknown(at: at)
        pump()
    }

    func finish(at instant: Date) {
        marker(.logStop, at: instant)
        if let at = openAt {
            let until = max(UTCInstant.millisecond(instant), at)
            close(until: until)
        }
        pump()
    }


    func handle(_ item: InputBufferItem, uptime: Double) {
        switch item {
        case .tap(let raw):
            receive(raw, uptime: uptime)
        case .tapRestart(let reason, let at):
            tapRestarts += 1
            lastTapRestart = InputTapRestart(at: UTCInstant.millisecond(at), reason: reason.rawValue)
            marker(.tapRestart(reason), at: at)
        case .activate(let pid, let name, let at):
            activate(pid: pid, name: name, at: at, uptime: uptime)
        case .terminated(let pid):
            names.forget(pid)
            arrivalPages[pid] = nil
        case .page(let pid, let read, let at):
            remember(read, for: pid)
            push(.page(pid, read))
            restateSiteUnknown(at: at)
        case .screenLocked(let locked, let at):
            screenLocked = locked
            restateLock(at: at)
        case .onConsole(let console, let at):
            onConsole = console
            restateLock(at: at)
        case .secureInput(let on, let at):
            guard on != secureInput else { break }
            secureInput = on
            marker(.secureInput(on: on), at: at)
        case .layout(let id, let at):
            guard id != layout else { break }
            layout = id
            marker(.layout(id: id), at: at)
        }
        pump()
    }

    func lost(_ count: Int, at instant: Date) {
        guard count > 0 else { return }
        _ = advance(to: instant)
        push(.lost(count))
        pump()
    }

    func session(screenLocked locked: Bool, onConsole console: Bool, at instant: Date) {
        screenLocked = locked
        onConsole = console
        restateLock(at: instant)
        pump()
    }

    func tick(now: Date, uptime: Double) {
        expire(uptime: uptime)
        if openAt != nil, now >= boundary {
            flushCoalesced()
            close(until: boundary)
        }
        pump()
    }

    func resolve(_ id: Int, _ lookup: InputElementLookup, ms: Int, page: InputPageRead? = nil,
                 focusOwner: Int32? = nil) {
        outstandingLookups = max(0, outstandingLookups - 1)
        guard let wait = awaiting.removeValue(forKey: id) else { return }
        if let focusOwner, focusOwner > 0 { answerOwners[id] = names.name(focusOwner) }
        if let page, let pid = wait.pid {
            answerPages[id] = page
            remember(page, for: pid)
        }
        if wait.pageRead, let pid = wait.pid {
            readingPages.remove(pid)
            if page == nil { remember(.page(.unknown), for: pid) }
        }
        switch lookup {
        case .found(let attributes, let action):
            answers[id] = InputElement(attributes: attributes, action: action, ms: max(0, ms))
        case .failed(let error):
            answers[id] = InputElement(ms: max(0, ms), err: error)
        }
        pump()
    }


    private var isLocked: Bool { screenLocked || !onConsole || frontmost == Self.loginWindow }

    private func excluded(_ name: String?) -> Bool {
        guard let name else { return false }
        return modes.mode(of: name) == .exclude
    }

    private func isBrowser(_ name: String?) -> Bool {
        Browsers.isBrowser(name)
    }

    private func arrivalPage(_ pid: Int32) -> InputPageRead {
        arrivalPages[pid] ?? .page(.unknown)
    }

    private func remember(_ read: InputPageRead, for pid: Int32) {
        if arrivalPages[pid] == nil, arrivalPages.count >= Self.pageLimit { arrivalPages.removeAll() }
        arrivalPages[pid] = read
    }

    private func pageMode(_ read: InputPageRead) -> RecordingMode {
        modes.mode(app: nil, page: read.page)
    }

    private func restateSiteUnknown(at instant: Date) {
        var unknown = false
        if let pid = frontmostPID, isBrowser(frontmost), !excluded(frontmost), modes.hasSiteRules {
            unknown = arrivalPage(pid) == .page(.unknown)
        }
        guard unknown != siteUnknownStated else { return }
        siteUnknownStated = unknown
        marker(.siteUnknown(on: unknown), at: instant)
    }

    private func inActivity(_ name: String?) -> Bool {
        guard let name else { return false }
        return modes.mode(of: name) == .activity
    }

    private func activityOwner(target: String?, poster: String?) -> String? {
        if inActivity(target) { return target }
        if inActivity(poster) { return poster }
        if target == nil, inActivity(frontmost) { return frontmost }
        return nil
    }

    private func restateLock(at instant: Date) {
        let locked = isLocked
        guard locked != lockStated else { return }
        lockStated = locked
        marker(.locked(on: locked), at: instant)
    }

    private func activate(pid: Int32, name: String?, at instant: Date, uptime: Double) {
        let resolved = name ?? names.name(pid)
        if name != nil { names.remember(pid, resolved) }
        frontmost = resolved
        frontmostPID = pid
        focusStale = true
        restateLock(at: instant)
        restateSiteUnknown(at: instant)
        guard !isLocked, !excluded(resolved) else { return }
        let at = advance(to: instant)
        flushCoalesced()
        var activation = Draft(.activate(app: 0, pid: Int(pid)), app: resolved)
        if isBrowser(resolved) {
            activation.pid = pid
            activation.gated = false
            if !readingPages.contains(pid) { readPage(pid, uptime: uptime) }
        }
        enqueue(activation, at: at, uptime: uptime)
    }


    private func receive(_ raw: RawInputEvent, uptime: Double) {
        guard !isLocked else { return }
        let target = raw.targetPID > 0 ? names.name(raw.targetPID) : nil
        let poster = raw.sourcePID != 0 ? names.name(raw.sourcePID) : nil
        if excluded(target) || excluded(poster) || (target == nil && excluded(frontmost)) { return }
        let instant = RawInputReading.instant(raw)
        restateSiteUnknown(at: instant)
        var pid: Int32?
        if target != nil {
            if isBrowser(target) { pid = raw.targetPID }
        } else if isBrowser(frontmost) {
            pid = frontmostPID
        }
        var read = pid.map(arrivalPage)
        if let pid, read == .page(.unknown), modes.hasSiteRules {
            if !readingPages.contains(pid) {
                _ = advance(to: instant)
                flushCoalesced()
                readPage(pid, uptime: uptime)
            }
            if readingPages.contains(pid) { read = nil }
        }
        let page = read.map(pageMode) ?? .record
        guard page != .exclude else { return }
        let site = read?.site?.host
        if let owner = activityOwner(target: target, poster: poster) {
            count(raw, for: Counted(owner: owner, kind: .keys, site: site), pid: pid, target: target, poster: poster,
                  uptime: uptime)
            return
        }
        if page == .activity, let owner = target ?? frontmost {
            count(raw, for: Counted(owner: owner, kind: .keys, site: site), pid: pid, target: target, poster: poster,
                  uptime: uptime)
            return
        }
        let mods = RawInputReading.modifiers(raw.flags)
        let point = (x: InputEventCodec.roundedToTenth(raw.x), y: InputEventCodec.roundedToTenth(raw.y))
        switch raw.type {
        case .keyDown:
            let at = advance(to: instant)
            flushCoalesced()
            let name = RawInputReading.keyNames[raw.keyCode]
            let fresh = focusStale || lastKeyDown.map { Self.elapsed(from: $0, to: at) >= Self.ms(limits.burstGap) } ?? true
            lastKeyDown = at
            focusStale = (name.map(RawInputReading.focusMovingKeys.contains) ?? false)
                || (pid != nil && RawInputReading.changesPage(keyCode: raw.keyCode, mods: mods))
                || RawInputReading.mayOpenPanel(keyCode: raw.keyCode, mods: mods)
            let key = InputKeyDown(code: raw.keyCode, key: RawInputReading.printable(raw.characters), name: name,
                                   mods: mods, isRepeat: raw.autorepeat)
            enqueue(Draft(.keyDown(key), app: target, syn: poster, pid: pid, keyTarget: target), at: at,
                    uptime: uptime,
                    lookup: fresh ? target.map { .focus(pid: raw.targetPID, app: $0, modes: modes) } : nil,
                    readsFocus: fresh)
        case .keyUp:
            let at = advance(to: instant)
            flushCoalesced()
            enqueue(Draft(.keyUp(code: raw.keyCode, app: nil, syn: nil), app: target, syn: poster, pid: pid,
                          keyTarget: target),
                    at: at, uptime: uptime)
        case .flagsChanged:
            if raw.keyCode == RawInputReading.functionKeyCode { focusStale = true }
            guard !raw.secureInput else { return }
            let at = advance(to: instant)
            flushCoalesced()
            enqueue(Draft(.flags(code: raw.keyCode, mods: mods), pid: pid, keyTarget: target), at: at, uptime: uptime)
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            let at = advance(to: instant)
            flushCoalesced()
            focusStale = true
            let pointer = InputPointer(button: RawInputReading.button(raw), x: point.x, y: point.y,
                                       clicks: raw.clicks, mods: mods)
            enqueue(Draft(.down(pointer), app: target, syn: poster, pid: pid), at: at, uptime: uptime,
                    lookup: target.map { .position(pid: raw.targetPID, app: $0, x: raw.x, y: raw.y) },
                    readsFocus: false, needsElement: true)
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            let at = advance(to: instant)
            flushCoalesced()
            let pointer = InputPointer(button: RawInputReading.button(raw), x: point.x, y: point.y,
                                       clicks: raw.clicks, mods: mods)
            enqueue(Draft(.up(pointer), app: target, syn: poster, pid: pid), at: at, uptime: uptime)
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
            let drag = raw.type == .mouseMoved ? nil : RawInputReading.button(raw)
            let move = Draft(.move(InputMove(x: point.x, y: point.y, drag: drag)), app: target, syn: poster, pid: pid)
            sample(move, at: advance(to: instant), uptime: uptime)
        case .scrollWheel:
            let scroll = InputScroll(x: point.x, y: point.y,
                                     dx: InputEventCodec.roundedToTenth(raw.scrollDX),
                                     dy: InputEventCodec.roundedToTenth(raw.scrollDY),
                                     lines: !raw.continuous,
                                     phase: RawInputReading.scrollPhase(scroll: raw.scrollPhase,
                                                                        momentum: raw.momentumPhase))
            sum(scroll, Draft(.scroll(scroll), app: target, syn: poster, pid: pid), at: advance(to: instant),
                uptime: uptime)
        }
    }

    private func count(_ raw: RawInputEvent, for counted: Counted, pid: Int32?, target: String?, poster: String?,
                       uptime: Double) {
        let instant = RawInputReading.instant(raw)
        var counted = counted
        switch raw.type {
        case .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown:
            _ = advance(to: instant)
            flushCoalesced()
            counted.kind = raw.type == .keyDown ? .keys : .clicks
            enqueueCount(counted, pid: pid)
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
            counted.kind = .moves
            let move = Draft(.move(InputMove(x: 0, y: 0)), app: target, syn: poster, pid: pid, counted: counted)
            sample(move, at: advance(to: instant), uptime: uptime)
        case .scrollWheel:
            counted.kind = .scrolls
            let scroll = InputScroll(x: 0, y: 0, dx: 0, dy: 0, lines: !raw.continuous,
                                     phase: RawInputReading.scrollPhase(scroll: raw.scrollPhase,
                                                                        momentum: raw.momentumPhase))
            sum(scroll, Draft(.scroll(scroll), app: target, syn: poster, pid: pid, counted: counted),
                at: advance(to: instant), uptime: uptime)
        case .keyUp, .flagsChanged, .leftMouseUp, .rightMouseUp, .otherMouseUp:
            return
        }
    }

    private func sample(_ move: Draft, at instant: Date, uptime: Double) {
        switch coalescing {
        case .scroll:
            flushCoalesced()
        case .move(let draft, let held):
            if draft.stream != move.stream
                || Self.elapsed(from: held, to: instant) >= Self.ms(limits.movePause) {
                flushCoalesced()
            }
        case nil:
            break
        }
        if let last = lastWrittenMove, lastWrittenMoveStream == move.stream,
           Self.elapsed(from: last, to: instant) < Self.ms(limits.movePeriod) {
            coalescing = .move(move, at: instant)
            return
        }
        coalescing = nil
        lastWrittenMove = instant
        lastWrittenMoveStream = move.stream
        enqueue(move, at: instant, uptime: uptime)
    }

    private func sum(_ scroll: InputScroll, _ draft: Draft, at instant: Date, uptime: Double) {
        if case .scroll(var held, let heldDraft, let first) = coalescing,
           held.phase == scroll.phase, held.lines == scroll.lines, heldDraft.stream == draft.stream,
           Self.elapsed(from: first, to: instant) < Self.ms(limits.scrollWindow) {
            held.dx = InputEventCodec.roundedToTenth(held.dx + scroll.dx)
            held.dy = InputEventCodec.roundedToTenth(held.dy + scroll.dy)
            coalescing = .scroll(held, heldDraft, at: first)
            return
        }
        flushCoalesced()
        coalescing = .scroll(scroll, draft, at: instant)
    }

    private func flushCoalesced() {
        guard let held = coalescing else { return }
        coalescing = nil
        switch held {
        case .move(let draft, let at):
            lastWrittenMove = at
            lastWrittenMoveStream = draft.stream
            enqueue(draft, at: at, uptime: 0)
        case .scroll(let scroll, var draft, let at):
            draft.body = .scroll(scroll)
            enqueue(draft, at: at, uptime: 0)
        }
    }


    private func advance(to instant: Date) -> Date {
        let instant = UTCInstant.millisecond(instant)
        if openAt != nil, instant >= boundary {
            flushCoalesced()
            close(until: boundary)
        }
        if openAt == nil {
            openChunk(at: max(InputEventBatch.minute(of: instant), lastUntil ?? .distantPast))
        }
        return max(instant, openAt ?? instant)
    }

    private func openChunk(at: Date) {
        openAt = at
        boundary = InputEventBatch.chunkBoundary(after: at, in: zone)
        push(.open(at: at, layout: layout))
    }

    private func close(until: Date) {
        if overflow > 0 {
            push(.lost(overflow))
            overflow = 0
        }
        push(.close(until: until))
        openAt = nil
        lastUntil = until
    }

    private func marker(_ body: InputEventBody, at instant: Date) {
        let at = advance(to: instant)
        flushCoalesced()
        push(.event(Pending(instant: at, draft: Draft(body))))
    }

    private func enqueue(_ draft: Draft, at instant: Date, uptime: Double, lookup: InputLookupTarget? = nil,
                         readsFocus: Bool = false, needsElement: Bool = false) {
        if let counted = draft.counted {
            enqueueCount(counted, pid: draft.pid)
            return
        }
        guard hasRoom() else { return }
        var draft = draft
        var id: Int?
        if let lookup {
            if outstandingLookups >= limits.waitingLookups {
                draft.body = draft.body.with(element: InputElement(err: .busy))
            } else {
                let requested = nextLookup
                nextLookup &+= 1
                outstandingLookups += 1
                let deadline = uptime + limits.lookupTimeout
                awaiting[requested] = (deadline, uptime, draft.pid, false)
                id = requested
                lookups.request(requested, lookup, deadline: deadline)
            }
        } else if readsFocus || needsElement {
            draft.body = draft.body.with(element: InputElement(err: .noElement))
        }
        push(.event(Pending(instant: instant, draft: draft, lookup: id, readsFocus: readsFocus)))
    }

    private func readPage(_ pid: Int32, uptime: Double) {
        guard outstandingLookups < limits.waitingLookups else { return }
        let id = nextLookup
        nextLookup &+= 1
        outstandingLookups += 1
        let deadline = uptime + limits.lookupTimeout
        awaiting[id] = (deadline, uptime, pid, true)
        readingPages.insert(pid)
        push(.pageRead(id, pid))
        lookups.request(id, .page(pid: pid, app: names.name(pid)), deadline: deadline)
    }

    private func enqueueCount(_ counted: Counted, pid: Int32?) {
        guard hasRoom() else { return }
        push(.count(counted, pid: pid))
    }

    private func hasRoom() -> Bool {
        guard items.count - head < limits.capacity else {
            overflow += 1
            return false
        }
        if overflow > 0 {
            push(.lost(overflow))
            overflow = 0
        }
        return true
    }

    private func push(_ item: Item) {
        items.append(item)
    }

    private func expire(uptime: Double) {
        for (id, wait) in awaiting where wait.deadline <= uptime {
            awaiting.removeValue(forKey: id)
            if wait.pageRead, let pid = wait.pid {
                readingPages.remove(pid)
                remember(.page(.unknown), for: pid)
            }
            answers[id] = InputElement(ms: max(0, Int(((uptime - wait.requested) * 1000).rounded())),
                                       err: .timeout)
        }
    }


    private func pump() {
        while head < items.count {
            let item = items[head]
            if case .event(let pending) = item, let id = pending.lookup, answers[id] == nil { break }
            if case .pageRead(let id, _) = item, answers[id] == nil { break }
            items[head] = .written
            head += 1
            write(item)
        }
        if head == items.count {
            items.removeAll(keepingCapacity: items.capacity <= 4096)
            head = 0
        } else if head > 1024, head * 2 > items.count {
            items.removeFirst(head)
            head = 0
        }
    }

    private func write(_ item: Item) {
        switch item {
        case .open(let at, let layout):
            chunk = OpenChunk(at: at, layout: layout)
            writer.chunkOpened(at: at, layout: layout)
        case .event(let pending):
            write(pending)
        case .count(var counted, let pid):
            if let pid {
                let read = writtenPages[pid] ?? .page(.unknown)
                guard pageMode(read) != .exclude else { return }
                counted.site = read.site?.host ?? counted.site
            }
            add(counted)
        case .page(let pid, let read):
            if writtenPages[pid] == nil, writtenPages.count >= Self.pageLimit { writtenPages.removeAll() }
            writtenPages[pid] = read
        case .pageRead(let id, let pid):
            answers[id] = nil
            if writtenPages[pid] == nil, writtenPages.count >= Self.pageLimit { writtenPages.removeAll() }
            writtenPages[pid] = answerPages.removeValue(forKey: id) ?? .page(.unknown)
        case .lost(let count):
            guard chunk != nil else { return }
            chunk?.lost += count
            writer.lostCounted(chunk?.lost ?? count)
        case .close(let until):
            guard let open = chunk else { return }
            chunk = nil
            guard !open.events.isEmpty || open.lost > 0 || !open.activity.isEmpty else {
                writer.chunkClosed(nil)
                return
            }
            let closed = InputChunk(at: open.at, until: max(until, open.at.addingTimeInterval(0.001)),
                                    layout: open.layout, apps: open.apps, sites: open.sites, events: open.events,
                                    activity: open.activity.values.sorted(by: InputActivity.order), lost: open.lost)
            chunksWritten += 1
            writer.chunkClosed(closed)
        case .written:
            break
        }
    }

    private func add(_ counted: Counted) {
        guard chunk != nil else { return }
        let app = chunk!.index(of: counted.owner, writer: writer)
        let site = counted.site.map { chunk!.siteIndex(of: $0, writer: writer) }
        let key = InputActivityKey(app: app, site: site)
        var entry = chunk!.activity[key] ?? InputActivity(app: app, site: site)
        entry.count(counted.kind)
        chunk!.activity[key] = entry
        writer.activityCounted(entry)
    }

    private func write(_ pending: Pending) {
        guard chunk != nil else { return }
        var body = pending.draft.body
        var element: InputElement?
        var pageAnswer: InputPageRead?
        var ownerAnswer: String?
        if let id = pending.lookup {
            element = answers.removeValue(forKey: id)
            pageAnswer = answerPages.removeValue(forKey: id)
            ownerAnswer = answerOwners.removeValue(forKey: id)
            if let element { body = body.with(element: element) }
        }
        if pending.readsFocus, let target = pending.draft.keyTarget, let ownerAnswer {
            keyFocus = ownerAnswer == target ? nil : (target, ownerAnswer)
        }
        let owner = pending.draft.keyTarget.flatMap { target in keyFocus?.target == target ? keyFocus?.owner : nil }
        if case .keyUp(let code?, _, _) = body, withheldCodes.remove(code) != nil { return }
        if let owner, excluded(owner) || isBrowser(owner) {
            withhold(body)
            return
        }
        var site: String?
        if let pid = pending.draft.pid {
            if let pageAnswer { writtenPages[pid] = pageAnswer }
            let read = writtenPages[pid] ?? .page(.unknown)
            let mode = pageMode(read)
            if pending.draft.gated {
                if mode == .exclude { return }
                if mode == .activity {
                    if let kind = body.countedKind, let owner = pending.draft.app {
                        add(Counted(owner: owner, kind: kind, site: read.site?.host))
                    }
                    return
                }
            }
            if mode != .exclude, owner == nil { site = read.site?.host }
        }
        if let owner, inActivity(owner) {
            if case .keyDown = body { add(Counted(owner: owner, kind: .keys, site: nil)) }
            withhold(body)
            return
        }
        guard chunk != nil else { return }
        switch body {
        case .keyDown(var key):
            if let code = key.code { withheldCodes.remove(code) }
            if pending.readsFocus, let element, element.err == nil {
                focusSecure = element.attributes.isSecure
            }
            if focusSecure { key.hidden = .secureField }
            if key.hidden != nil {
                if let code = key.code { hiddenCodes.insert(code) }
                key.code = nil
                key.key = nil
                key.mods = []
            } else if let code = key.code {
                hiddenCodes.remove(code)
            }
            body = .keyDown(key)
        case .keyUp(let code, let app, let syn):
            if let code, hiddenCodes.remove(code) != nil { body = .keyUp(code: nil, app: app, syn: syn) }
        case .down(let pointer):
            if let hit = pointer.el, hit.err == nil, hit.attributes.isSecure { focusSecure = true }
        case .flags:
            if focusSecure { return }
        default:
            break
        }
        let app = pending.draft.app.map { chunk!.index(of: owner ?? $0, writer: writer) }
        let siteIndex = app == nil ? nil : site.map { chunk!.siteIndex(of: $0, writer: writer) }
        let syn = pending.draft.syn.map { chunk!.index(of: $0, writer: writer) }
        let t = max(0, Self.elapsed(from: chunk!.at, to: pending.instant))
        let event = InputEvent(t: t, body: body.indexed(app: app, syn: syn), site: siteIndex)
        chunk!.events.append(event)
        if !body.isMarker {
            eventsWritten += 1
            ResourceMeter.shared.count(.inputEventsWritten)
        }
        writer.eventFinished(event)
    }

    static func elapsed(from start: Date, to end: Date) -> Int {
        Int(((end.timeIntervalSince1970 - start.timeIntervalSince1970) * 1000).rounded())
    }

    private static func ms(_ seconds: Double) -> Int {
        Int((seconds * 1000).rounded())
    }

    private func withhold(_ body: InputEventBody) {
        switch body {
        case .keyDown(let key): if let code = key.code { withheldCodes.insert(code) }
        case .keyUp(let code?, _, _): withheldCodes.remove(code)
        default: break
        }
    }


    private enum Item {
        case open(at: Date, layout: String)
        case event(Pending)
        case count(Counted, pid: Int32?)
        case page(Int32, InputPageRead)
        case pageRead(Int, Int32)
        case lost(Int)
        case close(until: Date)
        case written
    }

    private struct Counted {
        var owner: String
        var kind: InputActivity.Kind
        var site: String?
    }

    private struct Draft {
        var body: InputEventBody
        var app: String?
        var syn: String?
        var pid: Int32?
        var gated = true
        var counted: Counted?
        var keyTarget: String?

        init(_ body: InputEventBody, app: String? = nil, syn: String? = nil, pid: Int32? = nil,
             counted: Counted? = nil, keyTarget: String? = nil) {
            self.body = body
            self.app = app
            self.syn = syn
            self.pid = pid
            self.counted = counted
            self.keyTarget = keyTarget
        }

        var stream: Stream {
            Stream(app: app, syn: syn, owner: counted?.owner, site: counted?.site, pid: pid)
        }
    }

    private struct Stream: Equatable {
        var app: String?
        var syn: String?
        var owner: String?
        var site: String?
        var pid: Int32?
    }

    private struct Pending {
        let instant: Date
        let draft: Draft
        var lookup: Int?
        var readsFocus = false
    }

    private enum Coalescing {
        case move(Draft, at: Date)
        case scroll(InputScroll, Draft, at: Date)
    }

    private struct OpenChunk {
        let at: Date
        let layout: String
        var apps: [String] = []
        var indices: [String: Int] = [:]
        var sites: [String] = []
        var siteIndices: [String: Int] = [:]
        var events: [InputEvent] = []
        var activity: [InputActivityKey: InputActivity] = [:]
        var lost = 0

        mutating func siteIndex(of host: String, writer: InputChunkWriter) -> Int {
            if let index = siteIndices[host] { return index }
            let index = sites.count
            sites.append(host)
            siteIndices[host] = index
            writer.siteAdded(index, host: host)
            return index
        }

        mutating func index(of name: String, writer: InputChunkWriter) -> Int {
            if let index = indices[name] { return index }
            let index = apps.count
            apps.append(name)
            indices[name] = index
            writer.appAdded(index, name: name)
            return index
        }
    }
}

extension InputEventBody {
    var countedKind: InputActivity.Kind? {
        switch self {
        case .keyDown: return .keys
        case .down: return .clicks
        case .scroll: return .scrolls
        case .move: return .moves
        default: return nil
        }
    }

    func with(element: InputElement) -> InputEventBody {
        switch self {
        case .keyDown(var key):
            key.el = element
            return .keyDown(key)
        case .down(var pointer):
            pointer.el = element
            return .down(pointer)
        default:
            return self
        }
    }

    func indexed(app: Int?, syn: Int?) -> InputEventBody {
        switch self {
        case .keyDown(var key):
            key.app = app
            key.syn = syn
            return .keyDown(key)
        case .keyUp(let code, _, _):
            return .keyUp(code: code, app: app, syn: syn)
        case .down(var pointer):
            pointer.app = app
            pointer.syn = syn
            return .down(pointer)
        case .up(var pointer):
            pointer.app = app
            pointer.syn = syn
            return .up(pointer)
        case .move(var move):
            move.app = app
            move.syn = syn
            return .move(move)
        case .scroll(var scroll):
            scroll.app = app
            scroll.syn = syn
            return .scroll(scroll)
        case .activate(_, let pid):
            return .activate(app: app ?? 0, pid: pid)
        default:
            return self
        }
    }
}

final class InputProcessNames {
    static let unknown = "unknown"
    static let limit = 512

    private let resolve: (Int32) -> String?
    private var cache: [Int32: String] = [:]

    init(resolve: @escaping (Int32) -> String?) {
        self.resolve = resolve
    }

    var count: Int { cache.count }

    func name(_ pid: Int32) -> String {
        if let known = cache[pid] { return known }
        guard let resolved = resolve(pid) else { return Self.unknown }
        remember(pid, resolved)
        return resolved
    }

    func remember(_ pid: Int32, _ name: String) {
        if cache[pid] == nil, cache.count >= Self.limit { cache.removeAll(keepingCapacity: true) }
        cache[pid] = name
    }

    func forget(_ pid: Int32) {
        cache.removeValue(forKey: pid)
    }
}
