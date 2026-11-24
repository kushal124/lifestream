import CommonCrypto
import Foundation

final class Keybag {
    private var classKeys: [UInt32: Data]

    init(_ keybag: Data, password: String) throws {
        let fields = try Keybag.fields(of: keybag)
        var salt: Data?, rounds: UInt32?, doubleSalt: Data?, doubleRounds: UInt32?
        var classes: [(number: UInt32, wrap: UInt32, wrapped: Data)] = []
        var current: (number: UInt32?, wrap: UInt32?, wrapped: Data?) = (nil, nil, nil)
        var inHeader = true
        func close() {
            if let number = current.number, let wrap = current.wrap, let wrapped = current.wrapped { classes.append((number, wrap, wrapped)) }
            current = (nil, nil, nil)
        }
        for (tag, value) in fields {
            switch tag {
            case "SALT" where inHeader: salt = value
            case "ITER" where inHeader: rounds = Keybag.uint32(value)
            case "DPSL" where inHeader: doubleSalt = value
            case "DPIC" where inHeader: doubleRounds = Keybag.uint32(value)
            case "UUID":
                if inHeader, salt == nil, rounds == nil { continue }
                inHeader = false
                close()
            case "CLAS": current.number = Keybag.uint32(value)
            case "WRAP" where !inHeader: current.wrap = Keybag.uint32(value)
            case "WPKY": current.wrapped = value
            default: continue
            }
        }
        close()
        guard let salt, let rounds, rounds > 0 else { throw BackupError.unreadable("the keybag states no salt or rounds") }
        var passwordBytes = Data(password.utf8)
        var passwordKey = Data()
        var kek = Data()
        defer { Keybag.zero(&kek); Keybag.zero(&passwordKey); Keybag.zero(&passwordBytes) }
        if let doubleSalt, let doubleRounds, doubleRounds > 0 {
            passwordKey = try Keybag.pbkdf2(CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), passwordBytes, salt: doubleSalt, rounds: doubleRounds)
        } else {
            passwordKey = passwordBytes
        }
        kek = try Keybag.pbkdf2(CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), passwordKey, salt: salt, rounds: rounds)
        var unwrapped: [UInt32: Data] = [:]
        for entry in classes where entry.wrap & 2 != 0 && entry.wrapped.count == 40 {
            guard let key = Keybag.unwrap(entry.wrapped, with: kek) else { continue }
            unwrapped[entry.number] = key
        }
        guard !unwrapped.isEmpty else {
            throw classes.contains(where: { $0.wrap & 2 != 0 }) ? BackupError.wrongPassword : BackupError.unreadable("the keybag holds no class key")
        }
        classKeys = unwrapped
    }

    deinit { for number in classKeys.keys { Keybag.zero(&classKeys[number]!) } }

    func unwrap(classed data: Data) -> Data? {
        guard data.count == 44 else { return nil }
        let number = data.prefix(4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).littleEndian }
        guard let classKey = classKeys[number] else { return nil }
        return Keybag.unwrap(data.suffix(40), with: classKey)
    }


    static func fields(of data: Data) throws -> [(String, Data)] {
        var fields: [(String, Data)] = []
        var at = data.startIndex
        while at < data.endIndex {
            guard data.endIndex - at >= 8 else { throw BackupError.unreadable("the keybag ends inside a field") }
            let tag = String(decoding: data[at..<at + 4], as: UTF8.self)
            let length = Int(data[at + 4..<at + 8].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).bigEndian })
            guard length >= 0, data.endIndex - (at + 8) >= length else { throw BackupError.unreadable("the keybag field \(tag) overruns") }
            fields.append((tag, Data(data[at + 8..<at + 8 + length])))
            at += 8 + length
        }
        return fields
    }

    static func uint32(_ data: Data) -> UInt32? {
        guard data.count == 4 else { return nil }
        return data.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self).bigEndian }
    }

    static func pbkdf2(_ prf: CCPseudoRandomAlgorithm, _ password: Data, salt: Data, rounds: UInt32) throws -> Data {
        var derived = Data(count: 32)
        let status = password.withUnsafeBytes { passwordBytes in
            salt.withUnsafeBytes { saltBytes in
                derived.withUnsafeMutableBytes { out in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                                         passwordBytes.baseAddress?.assumingMemoryBound(to: Int8.self), passwordBytes.count,
                                         saltBytes.baseAddress?.assumingMemoryBound(to: UInt8.self), saltBytes.count,
                                         prf, rounds,
                                         out.baseAddress?.assumingMemoryBound(to: UInt8.self), out.count)
                }
            }
        }
        guard status == kCCSuccess else { throw BackupError.unreadable("the password's key did not derive (\(status))") }
        return derived
    }

    static func unwrap(_ wrapped: Data, with kek: Data) -> Data? {
        guard wrapped.count == 40, kek.count == 32 else { return nil }
        var raw = Data(count: 32)
        var rawLength = raw.count
        let status = kek.withUnsafeBytes { kekBytes in
            wrapped.withUnsafeBytes { wrappedBytes in
                raw.withUnsafeMutableBytes { out in
                    CCSymmetricKeyUnwrap(CCWrappingAlgorithm(kCCWRAPAES), CCrfc3394_iv, CCrfc3394_ivLen,
                                         kekBytes.baseAddress?.assumingMemoryBound(to: UInt8.self), kekBytes.count,
                                         wrappedBytes.baseAddress?.assumingMemoryBound(to: UInt8.self), wrappedBytes.count,
                                         out.baseAddress?.assumingMemoryBound(to: UInt8.self), &rawLength)
                }
            }
        }
        guard status == kCCSuccess, rawLength == 32 else { return nil }
        return raw
    }

    static func zero(_ data: inout Data) {
        data.withUnsafeMutableBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            memset_s(base, bytes.count, 0, bytes.count)
        }
    }
}

enum BackupCipher {
    private static let zeroIV = [UInt8](repeating: 0, count: kCCBlockSizeAES128)

    static func decrypt(_ data: Data, key: Data) throws -> Data {
        if let padded = try? run(data, key: key, options: CCOptions(kCCOptionPKCS7Padding)) { return padded }
        return try run(data, key: key, options: 0)
    }

    private static func run(_ data: Data, key: Data, options: CCOptions) throws -> Data {
        var out = Data(count: data.count + kCCBlockSizeAES128)
        var moved = 0
        let status = key.withUnsafeBytes { keyBytes in
            data.withUnsafeBytes { inBytes in
                out.withUnsafeMutableBytes { outBytes in
                    CCCrypt(CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES), options,
                            keyBytes.baseAddress, keyBytes.count, zeroIV,
                            inBytes.baseAddress, inBytes.count,
                            outBytes.baseAddress, outBytes.count, &moved)
                }
            }
        }
        guard status == kCCSuccess else { throw BackupError.unreadable("the bytes did not decrypt (\(status))") }
        return out.prefix(moved)
    }

    @discardableResult
    static func decrypt(file source: URL, key: Data, recorded: Int64?, into sink: (Data) throws -> Void) throws -> Int64 {
        var cryptor: CCCryptorRef?
        let made = key.withUnsafeBytes { keyBytes in
            CCCryptorCreate(CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES), 0, keyBytes.baseAddress, keyBytes.count, zeroIV, &cryptor)
        }
        guard made == kCCSuccess, let cryptor else { throw BackupError.unreadable("the file's key did not open (\(made))") }
        defer { CCCryptorRelease(cryptor) }
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        let block = kCCBlockSizeAES128
        let chunk = 4 << 20
        var out = Data(count: chunk + block)
        var held = Data()
        var passed: Int64 = 0
        func take(_ moved: Int) throws {
            var piece = held
            piece.append(out.prefix(moved))
            let keep = min(block, piece.count)
            let ready = piece.prefix(piece.count - keep)
            if !ready.isEmpty { try sink(Data(ready)); passed += Int64(ready.count) }
            held = Data(piece.suffix(keep))
        }
        while true {
            let piece = input.readData(ofLength: chunk)
            if piece.isEmpty { break }
            var moved = 0
            let status = piece.withUnsafeBytes { inBytes in
                out.withUnsafeMutableBytes { outBytes in
                    CCCryptorUpdate(cryptor, inBytes.baseAddress, inBytes.count, outBytes.baseAddress, outBytes.count, &moved)
                }
            }
            guard status == kCCSuccess else { throw BackupError.unreadable("\(source.lastPathComponent) did not decrypt (\(status))") }
            try take(moved)
        }
        var moved = 0
        let status = out.withUnsafeMutableBytes { outBytes in CCCryptorFinal(cryptor, outBytes.baseAddress, outBytes.count, &moved) }
        guard status == kCCSuccess else { throw BackupError.unreadable("\(source.lastPathComponent) does not end on a block") }
        try take(moved)
        let whole = passed + Int64(held.count)
        if recorded == nil || whole == recorded {
            if !held.isEmpty { try sink(held) }
            return whole
        }
        let pad = Int(held.last ?? 0)
        guard held.count == block, (1...block).contains(pad), held.suffix(pad).allSatisfy({ Int($0) == pad }) else {
            throw BackupError.unreadable(held.count < block ? "\(source.lastPathComponent) holds no padded block" : "\(source.lastPathComponent)'s last block is no padding")
        }
        if pad < block { try sink(Data(held.prefix(block - pad))) }
        return whole - Int64(pad)
    }
}
