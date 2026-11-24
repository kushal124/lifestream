import Foundation
import Recorder

func writeJSONLine<T: Encodable>(_ value: T) throws {
    FileHandle.standardOutput.write(try WireJSON.encode(value))
    FileHandle.standardOutput.write(Data("\n".utf8))
}
