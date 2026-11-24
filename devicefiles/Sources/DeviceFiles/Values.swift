import Foundation
import CryptoKit

public struct Values: Sendable {
    static let associatedData = Data("lifestream-mac:1:value".utf8)
    static let nonceBytes = 12
    static let tagBytes = 16

    let files: DeviceFiles

    public func encrypt(_ text: String) -> String {
        files.shared { keys in
            guard let keys else { return text }
            return Values.encrypt(text, key: keys.value, nonce: WholeFile.random(Values.nonceBytes))
        }
    }

    public func decrypt(_ text: String) throws -> String {
        try files.shared { keys in
            guard let keys else { return text }
            return try Values.decrypt(text, key: keys.value)
        }
    }

    static func encrypt(_ text: String, key: SymmetricKey, nonce: Data) -> String {
        let box = try! AES.GCM.seal(Data(text.utf8), using: key, nonce: AES.GCM.Nonce(data: nonce), authenticating: associatedData)
        var out = nonce
        out.append(box.ciphertext)
        out.append(box.tag)
        return out.base64EncodedString()
    }

    static func decrypt(_ text: String, key: SymmetricKey) throws -> String {
        guard let bytes = Data(base64Encoded: text), bytes.count >= nonceBytes + tagBytes else {
            throw DeviceFileError.unreadable(name: "a value", why: "it is not a value this Mac encrypted")
        }
        do {
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: bytes.subdata(in: 0..<nonceBytes)),
                ciphertext: bytes.subdata(in: nonceBytes..<(bytes.count - tagBytes)),
                tag: bytes.subdata(in: (bytes.count - tagBytes)..<bytes.count)
            )
            let plain = try AES.GCM.open(box, using: key, authenticating: associatedData)
            guard let opened = String(data: plain, encoding: .utf8) else {
                throw DeviceFileError.unreadable(name: "a value", why: "it is not text")
            }
            return opened
        } catch let failed as DeviceFileError {
            throw failed
        } catch {
            throw DeviceFileError.unreadable(name: "a value", why: "it fails its tag")
        }
    }
}
