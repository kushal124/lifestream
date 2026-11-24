import Accelerate
import CryptoKit
import Foundation

enum Group {
    struct Request: Decodable {
        let photos: [Photo]
        let statements: [Statement]
        let people: [String: String]
        let bars: Bars

        struct Photo: Decodable {
            let key: String
            let vectors: String?
            let faces: [Face]
        }

        struct Face: Decodable {
            let box: [Double]
            let tier: String
        }

        struct Statement: Decodable {
            let photo: String
            let box: [Double]
            let `is`: String?
            let is_not: [String]?
            let ignore: Bool?
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            photos = try container.decode([Photo].self, forKey: .photos)
            statements = try container.decodeIfPresent([Statement].self, forKey: .statements) ?? []
            people = try container.decodeIfPresent([String: String].self, forKey: .people) ?? [:]
            bars = try container.decodeIfPresent(Bars.self, forKey: .bars) ?? Bars()
        }

        private enum CodingKeys: String, CodingKey { case photos, statements, people, bars }
    }

    struct Bars: Codable {
        var edge = 0.64
        var assign = 0.56
        var margin = 0.08
        var maybe = 0.48

        init() {}

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            edge = try container.decodeIfPresent(Double.self, forKey: .edge) ?? edge
            assign = try container.decodeIfPresent(Double.self, forKey: .assign) ?? assign
            margin = try container.decodeIfPresent(Double.self, forKey: .margin) ?? margin
            maybe = try container.decodeIfPresent(Double.self, forKey: .maybe) ?? maybe
        }
    }

    struct Result: Encodable {
        let bars: Bars
        let photos: [Photo]
        let clusters: [Cluster]
        let unmatched: [Unmatched]
    }

    struct Photo: Encodable {
        let key: String
        let faces: [Face]
    }

    struct Face: Encodable {
        let face: String
        let person: String
        let cluster: String
        let typical: Double?
        let maybe: Scored?
    }

    struct Cluster: Encodable {
        let id: String
        let size: Int
        let suggested: [Scored]
    }

    struct Scored: Encodable {
        let person: String
        let score: Double
    }

    struct Unmatched: Encodable {
        let photo: String
        let box: [Double]
    }

    static let anchorNeighbours = 20
    static let edgeNeighbours = 30
    static let minClusterSize = 3
    static let suggestionCount = 3
    static let suggestionFloor = 0.30
    static let statementOverlap = 0.5

    static func run(_ request: Request) throws -> Result {
        let library = try Library(request.photos)
        let n = library.keys.count
        let bars = request.bars

        var stated: [Int: (overlap: Double, statement: Int)] = [:]
        var unmatched: [Int] = []
        for (index, statement) in request.statements.enumerated() {
            let kinds = [statement.is != nil, statement.is_not != nil, statement.ignore == true].filter { $0 }.count
            guard kinds == 1, statement.box.count == 4, statement.box.allSatisfy(\.isFinite) else {
                throw EngineError.request("statement \(index) must have a box and exactly one of is, is_not, ignore")
            }
            let best = (library.facesOnPhoto[statement.photo] ?? [])
                .map { (overlap: iou(library.boxes[$0], statement.box), face: $0) }
                .max { ($0.overlap, -$0.face) < ($1.overlap, -$1.face) }
            guard let best, best.overlap >= statementOverlap else {
                unmatched.append(index)
                continue
            }
            if let held = stated[best.face] {
                guard best.overlap > held.overlap else {
                    unmatched.append(index)
                    continue
                }
                unmatched.append(held.statement)
            }
            stated[best.face] = (best.overlap, index)
        }
        var person = [Int](repeating: -1, count: n)
        var ignored = [Bool](repeating: false, count: n)
        var notPeople = [Int: Set<Int>]()
        var slugs: [String] = []
        var slugIndex: [String: Int] = [:]
        func personID(_ slug: String) throws -> Int {
            let canonical = try follow(slug, request.people)
            if let id = slugIndex[canonical] { return id }
            slugs.append(canonical)
            slugIndex[canonical] = slugs.count - 1
            return slugs.count - 1
        }
        for (face, held) in stated.sorted(by: { $0.key < $1.key }) {
            let statement = request.statements[held.statement]
            if let slug = statement.is { person[face] = try personID(slug) }
            if let slugs = statement.is_not { notPeople[face] = Set(try slugs.map(personID)) }
            if statement.ignore == true { ignored[face] = true }
        }
        let anchors = (0..<n).filter { person[$0] >= 0 }
        let anchored = person.map { $0 >= 0 }

        func accepts(_ ranked: Library.Ranked?, face: Int, people: Int) -> Bool {
            guard let ranked, ranked.score >= bars.assign, ranked.score - ranked.second >= bars.margin else { return false }
            return ranked.group >= people || !(notPeople[face]?.contains(ranked.group) ?? false)
        }

        let candidates = (0..<n).filter { !anchored[$0] && !ignored[$0] && library.tier[$0] != Settings.observe }
        let personGroups = anchors.map { person[$0] }
        var claimedByPerson = Set<Int>()
        let byPeople = library.rank(candidates, gallery: anchors, groups: personGroups, names: slugs)
        for (face, ranked) in zip(candidates, byPeople) where accepts(ranked, face: face, people: slugs.count) {
            claimedByPerson.insert(face)
        }

        let seeds = candidates.filter { library.tier[$0] == "seed" && !claimedByPerson.contains($0) }
        var union = UnionFind(seeds.map { library.photo[$0] })
        var edges: [(similarity: Float, a: Int, b: Int)] = []
        for (row, neighbours) in library.nearest(seeds, gallery: seeds, k: edgeNeighbours).enumerated() {
            for (similarity, column) in neighbours where Double(similarity) >= bars.edge {
                edges.append((similarity, min(row, column), max(row, column)))
            }
        }
        edges.sort { ($0.similarity, $1.a, $1.b) > ($1.similarity, $0.a, $0.b) }
        for edge in edges { union.join(edge.a, edge.b) }
        var members = union.groups().filter { $0.count >= minClusterSize }.map { $0.map { seeds[$0] } }
        var cluster = [Int](repeating: -1, count: n)
        for (id, group) in members.enumerated() { for face in group { cluster[face] = id } }

        let clustered = members.flatMap { $0 }
        let gallery = (anchors + clustered).sorted()
        let groups = gallery.map { anchored[$0] ? person[$0] : slugs.count + cluster[$0] }
        let names = slugs + members.map { library.keys[$0.min()!] }
        let joiners = candidates.filter { cluster[$0] < 0 }
        var claims: [Claim] = []
        for (face, ranked) in zip(joiners, library.rank(joiners, gallery: gallery, groups: groups, names: names))
        where accepts(ranked, face: face, people: slugs.count) {
            claims.append(Claim(face: face, group: ranked!.group, score: ranked!.score, margin: ranked!.score - ranked!.second))
        }
        var taken = [Int: Set<Int>]()
        for (face, group) in zip(gallery, groups) { taken[library.photo[face], default: []].insert(group) }
        for claim in library.onePerPhoto(claims, taken: taken) {
            if claim.group < slugs.count {
                person[claim.face] = claim.group
            } else {
                cluster[claim.face] = claim.group - slugs.count
                members[claim.group - slugs.count].append(claim.face)
            }
        }

        let centres = members.map { library.centre(of: $0) }
        let suggestions = library.rank(centres, gallery: anchors, groups: personGroups, names: slugs, all: true)
        var clusters: [Cluster] = []
        var clusterIDs: [String] = []
        var typical = [Double?](repeating: nil, count: n)
        for (id, group) in members.enumerated() {
            let lowest = group.map { library.keys[$0] }.min()!
            let hash = SHA256.hash(data: Data(lowest.utf8)).map { String(format: "%02x", $0) }.joined()
            clusterIDs.append(String(hash.prefix(16)))
            for face in group { typical[face] = rounded(Double(library.similarity(face, to: centres[id])), 4) }
            let declined = group.reduce(into: Set<Int>()) { $0.formUnion(notPeople[$1] ?? []) }
            let suggested = (suggestions[id]?.all ?? []).filter { $0.score >= suggestionFloor && !declined.contains($0.group) }
                .prefix(suggestionCount).map { Scored(person: slugs[$0.group], score: rounded($0.score, 4)) }
            clusters.append(Cluster(id: clusterIDs[id], size: group.count, suggested: Array(suggested)))
        }
        clusters.sort { ($0.size, $1.id) > ($1.size, $0.id) }

        var maybe = [Scored?](repeating: nil, count: n)
        for (face, ranked) in zip(candidates, byPeople) where person[face] < 0 && cluster[face] < 0 {
            guard let ranked, ranked.score >= bars.maybe, !(notPeople[face]?.contains(ranked.group) ?? false) else { continue }
            maybe[face] = Scored(person: slugs[ranked.group], score: rounded(ranked.score, 4))
        }

        let photos = library.photoKeys.map { key in
            Photo(key: key, faces: library.facesOnPhoto[key]!.map { face in
                Face(face: library.keys[face], person: person[face] >= 0 ? slugs[person[face]] : "",
                     cluster: cluster[face] >= 0 ? clusterIDs[cluster[face]] : "", typical: typical[face], maybe: maybe[face])
            })
        }
        return Result(bars: bars, photos: photos, clusters: clusters,
                      unmatched: unmatched.sorted().map { Unmatched(photo: request.statements[$0].photo, box: request.statements[$0].box) })
    }

    static func follow(_ slug: String, _ people: [String: String]) throws -> String {
        var current = slug
        var seen: Set<String> = [slug]
        while let next = people[current], next != current {
            guard seen.insert(next).inserted else { throw EngineError.request("people merge into each other: \(slug)") }
            current = next
        }
        return current
    }

    static func iou(_ a: [Double], _ b: [Double]) -> Double {
        let w = max(0, min(a[2], b[2]) - max(a[0], b[0])), h = max(0, min(a[3], b[3]) - max(a[1], b[1]))
        let union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - w * h
        return union > 0 ? w * h / union : 0
    }

    struct Claim {
        let face: Int
        let group: Int
        let score: Double
        let margin: Double
    }
}

private struct Library {
    var keys: [String] = []
    var boxes: [[Double]] = []
    var tier: [String] = []
    var photo: [Int] = []
    var photoKeys: [String] = []
    var facesOnPhoto: [String: [Int]] = [:]
    var vectors: [Float] = []

    static let dimension = 512

    init(_ photos: [Group.Request.Photo]) throws {
        var faces: [(key: String, box: [Double], tier: String, photo: Int, vector: ArraySlice<Float>)] = []
        var byPhoto: [String: [String]] = [:]
        let tiers = Set(Settings.tiers.map(\.name) + [Settings.observe])
        for (index, photo) in photos.enumerated() {
            guard byPhoto[photo.key] == nil else { throw EngineError.request("photo \(photo.key) appears twice") }
            let vectors = try Self.read(photo, count: photo.faces.count)
            var keys: [String] = []
            for (number, face) in photo.faces.enumerated() {
                guard face.box.count == 4, face.box.allSatisfy(\.isFinite), tiers.contains(face.tier) else {
                    throw EngineError.request("photo \(photo.key) face \(number) needs a box of four numbers and a tier")
                }
                let key = faceKey(photo.key, face.box)
                guard !keys.contains(key) else { throw EngineError.request("face \(key) appears twice") }
                keys.append(key)
                faces.append((key, face.box, face.tier, index,
                              vectors[(number * Self.dimension)..<((number + 1) * Self.dimension)]))
            }
            byPhoto[photo.key] = keys
        }
        faces.sort { $0.key < $1.key }
        photoKeys = photos.map(\.key).sorted()
        let photoOrder = Dictionary(uniqueKeysWithValues: photoKeys.enumerated().map { ($1, $0) })
        var position: [String: Int] = [:]
        vectors.reserveCapacity(faces.count * Self.dimension)
        for (index, face) in faces.enumerated() {
            keys.append(face.key)
            boxes.append(face.box)
            tier.append(face.tier)
            photo.append(photoOrder[photos[face.photo].key]!)
            vectors.append(contentsOf: face.vector)
            position[face.key] = index
        }
        for (key, faceKeys) in byPhoto { facesOnPhoto[key] = faceKeys.map { position[$0]! } }
    }

    private static func read(_ photo: Group.Request.Photo, count: Int) throws -> [Float] {
        guard count > 0 else { return [] }
        guard let path = photo.vectors else { throw EngineError.request("photo \(photo.key) has faces but no vectors") }
        let data: Data
        do { data = try Data(contentsOf: URL(fileURLWithPath: path)) } catch {
            throw EngineError.failed("cannot read \(path): \(error.localizedDescription)")
        }
        guard data.count == count * dimension * 4 else {
            throw EngineError.request("\(path) holds \(data.count) bytes, not \(count) vectors")
        }
        let values = data.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
        guard values.allSatisfy(\.isFinite) else { throw EngineError.request("\(path) holds a value that is not a number") }
        return values
    }

    func nearest(_ queries: [Int], gallery: [Int], k: Int) -> [[(Float, Int)]] {
        nearest(rows: gather(queries), count: queries.count, self: queries, gallery: gallery, k: k)
    }

    func nearest(rows: [Float], count: Int, self faces: [Int]?, gallery: [Int], k: Int) -> [[(Float, Int)]] {
        let d = Self.dimension, m = gallery.count
        guard count > 0, m > 0 else { return Array(repeating: [], count: count) }
        let galleryRows = gather(gallery)
        var result = [[(Float, Int)]](repeating: [], count: count)
        let block = 256
        var scores = [Float](repeating: 0, count: block * m)
        for start in stride(from: 0, to: count, by: block) {
            let rowsHere = min(block, count - start)
            rows.withUnsafeBufferPointer { q in
                galleryRows.withUnsafeBufferPointer { g in
                    cblas_sgemm(CblasRowMajor, CblasNoTrans, CblasTrans, Int32(rowsHere), Int32(m), Int32(d), 1,
                                q.baseAddress! + start * d, Int32(d), g.baseAddress!, Int32(d), 0, &scores, Int32(m))
                }
            }
            scores.withUnsafeBufferPointer { scores in
                result.withUnsafeMutableBufferPointer { result in
                    let s = Unchecked(scores), out = Unchecked(result)
                    DispatchQueue.concurrentPerform(iterations: rowsHere) { r in
                        let own = faces?[start + r] ?? -1
                        var best: [(Float, Int)] = []
                        best.reserveCapacity(k + 1)
                        let row = s.value.baseAddress! + r * m
                        for column in 0..<m where gallery[column] != own {
                            let value = row[column]
                            if best.count == k, value <= best[k - 1].0 { continue }
                            var at = best.count
                            while at > 0, best[at - 1].0 < value { at -= 1 }
                            best.insert((value, column), at: at)
                            if best.count > k { best.removeLast() }
                        }
                        out.value.baseAddress![start + r] = best
                    }
                }
            }
        }
        return result
    }

    struct Ranked {
        let group: Int
        let score: Double
        let second: Double
        let all: [(group: Int, score: Double)]
    }

    func rank(_ queries: [Int], gallery: [Int], groups: [Int], names: [String]) -> [Ranked?] {
        let neighbours = nearest(queries, gallery: gallery, k: Group.anchorNeighbours)
        return neighbours.map { Self.rank($0, groups: groups, names: names, all: false) }
    }

    func rank(_ rows: [[Float]], gallery: [Int], groups: [Int], names: [String], all: Bool) -> [Int: Ranked] {
        let neighbours = nearest(rows: rows.flatMap { $0 }, count: rows.count, self: nil, gallery: gallery,
                                 k: Group.anchorNeighbours)
        var result: [Int: Ranked] = [:]
        for (row, list) in neighbours.enumerated() { result[row] = Self.rank(list, groups: groups, names: names, all: all) }
        return result
    }

    private static func rank(_ neighbours: [(Float, Int)], groups: [Int], names: [String], all: Bool) -> Ranked? {
        var top: [Int: [Double]] = [:]
        for (similarity, column) in neighbours where top[groups[column], default: []].count < 2 {
            top[groups[column], default: []].append(Double(similarity))
        }
        let ranked = top.map { (group: $0.key, score: $0.value.reduce(0, +) / Double($0.value.count)) }
            .sorted { ($0.score, names[$1.group]) > ($1.score, names[$0.group]) }
        guard let first = ranked.first else { return nil }
        return Ranked(group: first.group, score: first.score, second: ranked.count > 1 ? ranked[1].score : -1,
                      all: all ? ranked : [])
    }

    func onePerPhoto(_ claims: [Group.Claim], taken: [Int: Set<Int>]) -> [Group.Claim] {
        var taken = taken
        var kept: [Group.Claim] = []
        for claim in claims.sorted(by: { ($0.score, $0.margin, $1.face) > ($1.score, $1.margin, $0.face) }) {
            guard taken[photo[claim.face], default: []].insert(claim.group).inserted else { continue }
            kept.append(claim)
        }
        return kept
    }

    func centre(of faces: [Int]) -> [Float] {
        var sum = [Float](repeating: 0, count: Self.dimension)
        for face in faces {
            for i in 0..<Self.dimension { sum[i] += vectors[face * Self.dimension + i] }
        }
        let norm = max(sum.reduce(0) { $0 + $1 * $1 }.squareRoot(), 1e-12)
        return sum.map { $0 / norm }
    }

    func similarity(_ face: Int, to centre: [Float]) -> Float {
        (0..<Self.dimension).reduce(Float(0)) { $0 + vectors[face * Self.dimension + $1] * centre[$1] }
    }

    private func gather(_ faces: [Int]) -> [Float] {
        var rows = [Float](repeating: 0, count: faces.count * Self.dimension)
        rows.withUnsafeMutableBufferPointer { out in
            vectors.withUnsafeBufferPointer { all in
                for (row, face) in faces.enumerated() {
                    (out.baseAddress! + row * Self.dimension)
                        .update(from: all.baseAddress! + face * Self.dimension, count: Self.dimension)
                }
            }
        }
        return rows
    }
}

private struct Unchecked<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

private struct UnionFind {
    private var parent: [Int]
    private var photos: [Set<Int>]

    init(_ photoOfEach: [Int]) {
        parent = Array(photoOfEach.indices)
        photos = photoOfEach.map { [$0] }
    }

    mutating func root(_ x: Int) -> Int {
        var x = x
        while parent[x] != x {
            parent[x] = parent[parent[x]]
            x = parent[x]
        }
        return x
    }

    mutating func join(_ a: Int, _ b: Int) {
        var ra = root(a), rb = root(b)
        guard ra != rb, photos[ra].isDisjoint(with: photos[rb]) else { return }
        if photos[ra].count < photos[rb].count { swap(&ra, &rb) }
        parent[rb] = ra
        photos[ra].formUnion(photos[rb])
        photos[rb] = []
    }

    mutating func groups() -> [[Int]] {
        var byRoot: [Int: [Int]] = [:]
        var order: [Int] = []
        for x in parent.indices {
            let r = root(x)
            if byRoot[r] == nil { order.append(r) }
            byRoot[r, default: []].append(x)
        }
        return order.map { byRoot[$0]! }
    }
}
