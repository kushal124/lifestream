import Foundation
import Vision
import CoreML
import ImageIO
import Darwin

struct Sample: Codable {
    let index: Int
    let status: String
    let wallSeconds: Double
    let cpuSeconds: Double
    let textMultisetEqual: Bool
    let referenceLines: Int
    let observedLines: Int
    let commonLines: Int
    let referenceTokens: Int
    let observedTokens: Int
    let commonTokens: Int
    let tokenMultisetRecall: Double
}
struct VariantResult: Codable { let name: String; let samples: [Sample] }
struct Report: Codable {
    let defaultRevision: Int
    let availableDevices: [String: [String]]
    let variants: [VariantResult]
}
struct Variant {
    let name: String
    var revision: Int?
    var minimumTextHeight: Float = 0
    var languageCorrection = false
    var explicitEnglish = false
    var reuse = false
    var sequence = false
    var devices: [VNComputeStage: MLComputeDevice] = [:]
}
func deviceName(_ value: MLComputeDevice) -> String {
    switch value {
    case .cpu: return "cpu"
    case .gpu: return "gpu"
    case .neuralEngine: return "neural-engine"
    @unknown default: return "unknown"
    }
}
func request(_ variant: Variant) -> VNRecognizeTextRequest {
    let result = VNRecognizeTextRequest()
    result.recognitionLevel = .accurate
    result.usesLanguageCorrection = variant.languageCorrection
    result.minimumTextHeight = variant.minimumTextHeight
    result.automaticallyDetectsLanguage = false
    if variant.explicitEnglish { result.recognitionLanguages = ["en-US"] }
    if let revision = variant.revision { result.revision = revision }
    for (stage, device) in variant.devices { result.setComputeDevice(device, for: stage) }
    return result
}
func cpu() -> Double {
    var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
    return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec)
        + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1e6
}
func multiset(_ request: VNRecognizeTextRequest) -> [String: Int] {
    var result: [String: Int] = [:]
    for observation in request.results ?? [] {
        if let text = observation.topCandidates(1).first?.string { result[text, default: 0] += 1 }
    }
    return result
}
func tokens(_ lines: [String: Int]) -> [String: Int] {
    var result: [String: Int] = [:]
    for (line, count) in lines {
        for token in line.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted) where !token.isEmpty {
            result[token, default: 0] += count
        }
    }
    return result
}
let arguments = CommandLine.arguments
if !(3...4).contains(arguments.count) { fatalError("Expected input JSON and output JSON") }
let paths = Array(try JSONDecoder().decode([String].self, from: Data(contentsOf: URL(fileURLWithPath: arguments[1]))).prefix(20))
guard !paths.isEmpty else { fatalError("No input images") }
let baseRequest = request(Variant(name: "default"))
let supported = try baseRequest.supportedComputeStageDevices
var devices: [String: [String]] = [:]
for (stage, values) in supported { devices[stage.rawValue] = values.map(deviceName) }
var variants = [Variant(name: "baseline-first"), Variant(name: "baseline-repeat"),
                Variant(name: "request-reused", reuse: true), Variant(name: "sequence-handler", reuse: true, sequence: true)]
for revision in VNRecognizeTextRequest.supportedRevisions where revision != baseRequest.revision {
    variants.append(Variant(name: "revision-\(revision)", revision: revision))
}
for stage in supported.keys.sorted(by: { $0.rawValue < $1.rawValue }) {
    for device in supported[stage] ?? [] {
        variants.append(Variant(name: "stage-\(stage.rawValue)-\(deviceName(device))", devices: [stage: device]))
    }
}
for family in ["cpu", "gpu", "neural-engine"] {
    var assignments: [VNComputeStage: MLComputeDevice] = [:]
    for (stage, values) in supported {
        if let device = values.first(where: { deviceName($0) == family }) { assignments[stage] = device }
    }
    if assignments.count > 1 { variants.append(Variant(name: "all-supported-\(family)", devices: assignments)) }
}
if arguments.last == "--text-policy" {
    variants = [Variant(name: "baseline-first"), Variant(name: "baseline-repeat")]
    for height: Float in [0, 0.005, 0.01, 0.015] {
        for correction in [false, true] {
            variants.append(Variant(name: "minimum-\(height)-correction-\(correction)", revision: 3,
                minimumTextHeight: height, languageCorrection: correction, explicitEnglish: true))
        }
    }
}
variants.append(Variant(name: "baseline-final"))
var references: [[String: Int]] = []
var results: [VariantResult] = []
for (variantIndex, variant) in variants.enumerated() {
    let reusable = request(variant)
    let sequence = VNSequenceRequestHandler()
    var samples: [Sample] = []
    for (index, path) in paths.enumerated() {
        try autoreleasepool {
            guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0,
                    [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else {
                throw NSError(domain: "OCRComputeBenchmark.invalid-image", code: 1)
            }
            let cpuStart = cpu(), start = ProcessInfo.processInfo.systemUptime
            let current = variant.reuse ? reusable : request(variant)
            var status = "complete"
            do {
                if variant.sequence { try sequence.perform([current], on: image) }
                else { try VNImageRequestHandler(cgImage: image, options: [:]).perform([current]) }
            } catch { status = "request-failed" }
            let wallSeconds = ProcessInfo.processInfo.systemUptime - start, cpuSeconds = cpu() - cpuStart
            let observed = status == "complete" ? multiset(current) : [:]
            if variantIndex == 0 { references.append(observed) }
            let reference = references[index]
            let common = reference.reduce(0) { $0 + min($1.value, observed[$1.key] ?? 0) }
            let referenceTokens = tokens(reference), observedTokens = tokens(observed)
            let commonTokens = referenceTokens.reduce(0) { $0 + min($1.value, observedTokens[$1.key] ?? 0) }
            let tokenCount = referenceTokens.values.reduce(0, +)
            samples.append(Sample(index: index, status: status, wallSeconds: wallSeconds, cpuSeconds: cpuSeconds,
                textMultisetEqual: status == "complete" && reference == observed,
                referenceLines: reference.values.reduce(0, +), observedLines: observed.values.reduce(0, +), commonLines: common,
                referenceTokens: tokenCount, observedTokens: observedTokens.values.reduce(0, +), commonTokens: commonTokens,
                tokenMultisetRecall: tokenCount == 0 ? 1 : Double(commonTokens) / Double(tokenCount)))
        }
    }
    results.append(VariantResult(name: variant.name, samples: samples))
    let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(Report(defaultRevision: baseRequest.revision, availableDevices: devices, variants: results))
        .write(to: URL(fileURLWithPath: arguments[2]), options: .atomic)
    print("\(variant.name): \(samples.filter { $0.textMultisetEqual }.count)/\(samples.count) exact; wall \(samples.reduce(0) { $0 + $1.wallSeconds }); cpu \(samples.reduce(0) { $0 + $1.cpuSeconds })")
}
