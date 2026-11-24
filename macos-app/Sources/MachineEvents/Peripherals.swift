import Foundation

struct DisplayFacts: Equatable, Sendable {
    let id: UInt32
    let name: String?
    let builtIn: Bool
    let main: Bool
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let pixelWidth: Int?
    let pixelHeight: Int?
    let widthMM: Double?
    let heightMM: Double?
    let mirrorOf: UInt32?

    func sameArrangement(as other: DisplayFacts) -> Bool {
        builtIn == other.builtIn && main == other.main && x == other.x && y == other.y
            && width == other.width && height == other.height && pixelWidth == other.pixelWidth
            && pixelHeight == other.pixelHeight && widthMM == other.widthMM && heightMM == other.heightMM
            && mirrorOf == other.mirrorOf
    }
}

struct BluetoothFacts: Equatable, Sendable {
    let address: String?
    let name: String?
    let classOfDevice: UInt32

    var identity: String { address ?? name ?? "" }
}

struct Peripherals: Equatable, Sendable {
    var displays: [DisplayFacts]?
    var bluetooth: [BluetoothFacts]?
    var lux: Double?
}

enum PeripheralSignal: Sendable {
    case displays([DisplayFacts], at: Date)
    case connected(BluetoothFacts, at: Date)
    case disconnected(BluetoothFacts, at: Date)
}

protocol PeripheralProbe: AnyObject {
    func start(queue: DispatchQueue, changed: @escaping (PeripheralSignal) -> Void) -> Peripherals
    func stop()
    func lux() -> Double?
}
