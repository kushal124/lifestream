import AppKit
import AudioToolbox
import CoreAudio
import CoreMediaIO
import Darwin
import Evidence
import Foundation

public final class SystemDeviceUseProbe: DeviceUseProbe, @unchecked Sendable {
    private let system: any DeviceSystem
    private let ownPID: pid_t
    private let ownApp: String
    private let lock = NSLock()
    private var signal: (@Sendable (DeviceUseSignal) -> Void)?
    private let heard = Heard()
    private var listeners: [ListenerKey: Meaning] = [:]
    private var listened = Listened()
    private var refused = false
    private var watched: Set<AudioObjectID> = []
    private var trusted: [AudioObjectID: ProcessRunning] = [:]
    private var lastInput: (running: Bool, holders: Set<AudioObjectID>)?
    private var names: [AudioObjectID: ProcessName] = [:]

    public convenience init(ownPID: pid_t = getpid(), ownApp: String = RecordingModes.ownApp) {
        self.init(system: MacDeviceSystem(), ownPID: ownPID, ownApp: ownApp)
    }

    init(system: any DeviceSystem, ownPID: pid_t, ownApp: String) {
        self.system = system
        self.ownPID = ownPID
        self.ownApp = ownApp
    }

    deinit { stopObserving() }

    public func read(at: Date) -> DeviceUse {
        lock.lock()
        defer { lock.unlock() }
        let marks = heard.take()
        if marks.restarted { forgetListeners() }
        if marks.everything { trusted = [:] }
        let processes = system.processes()
        let defaultOutput = processes == nil ? nil : system.defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
        let defaultInput = processes == nil ? nil : system.defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
        let cameras = system.cameras()
        listen(processes: processes, defaultOutput: defaultOutput, defaultInput: defaultInput, cameras: cameras?.all)
        let audio = processes.map { readAudio($0, changed: marks.processes, defaultOutput: defaultOutput,
                                               defaultInput: defaultInput) }
        return DeviceUse(at: at, audio: audio, cameras: cameras?.running)
    }

    public func observe(_ signal: @escaping @Sendable (DeviceUseSignal) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        self.signal = signal
        _ = heard.take()
        let processes = system.processes()
        listen(processes: processes,
               defaultOutput: processes == nil ? nil : system.defaultDevice(kAudioHardwarePropertyDefaultOutputDevice),
               defaultInput: processes == nil ? nil : system.defaultDevice(kAudioHardwarePropertyDefaultInputDevice),
               cameras: system.cameras()?.all)
    }

    public func stopObserving() {
        lock.lock()
        defer { lock.unlock() }
        signal = nil
        forgetListeners()
        _ = heard.take()
    }

    public func recheck() {
        heard.markEverything()
    }


    private func readAudio(_ processes: [AudioObjectID], changed: Set<AudioObjectID>,
                           defaultOutput: AudioObjectID?, defaultInput: AudioObjectID?) -> AudioUse {
        var (flags, reused) = runningFlags(processes) { changed.contains($0) }
        var holders = Set(processes.filter { flags[$0]?.input == true })
        let running = defaultInput.map(system.runningSomewhere) ?? false
        if reused, let lastInput, lastInput.running != running, lastInput.holders == holders {
            flags = runningFlags(processes) { _ in true }.flags
            holders = Set(processes.filter { flags[$0]?.input == true })
        }
        lastInput = signal == nil ? nil : (running, holders)

        var microphone: [AudioClient] = []
        var sound: [AudioClient] = []
        for process in processes {
            let input = flags[process]?.input == true
            let output = flags[process]?.output == true
            guard input || output else { continue }
            guard let pid = system.pid(process), pid != ownPID else { continue }
            let name = processName(process, pid: pid)
            guard name.app != ownApp, name.raw != ownApp else { continue }
            if input { microphone += clients(process, pid: pid, name: name, scope: kAudioObjectPropertyScopeInput) }
            if output { sound += clients(process, pid: pid, name: name, scope: kAudioObjectPropertyScopeOutput) }
        }
        return AudioUse(microphone: microphone, sound: sound,
                        output: system.level(defaultOutput, scope: kAudioDevicePropertyScopeOutput),
                        input: system.level(defaultInput, scope: kAudioDevicePropertyScopeInput),
                        defaultInputRunning: running)
    }

    private func runningFlags(_ processes: [AudioObjectID],
                              reread: (AudioObjectID) -> Bool) -> (flags: [AudioObjectID: ProcessRunning], reused: Bool) {
        var flags: [AudioObjectID: ProcessRunning] = [:]
        var reused = false
        for process in processes {
            if !reread(process), let known = trusted[process] {
                flags[process] = known
                reused = true
                continue
            }
            let read = system.running(process)
            flags[process] = read
            trusted[process] = read.answered && watched.contains(process) ? read : nil
        }
        return (flags, reused)
    }

    private func clients(_ process: AudioObjectID, pid: pid_t, name: ProcessName,
                         scope: AudioObjectPropertyScope) -> [AudioClient] {
        let devices = system.devices(process, scope: scope)
        guard !devices.isEmpty else { return [AudioClient(pid: pid, app: name.app, rawApp: name.raw, device: nil)] }
        return devices.map { AudioClient(pid: pid, app: name.app, rawApp: name.raw, device: $0) }
    }

    private func processName(_ process: AudioObjectID, pid: pid_t) -> ProcessName {
        if let known = names[process] { return known }
        let name = system.name(process, pid: pid)
        if signal != nil { names[process] = name }
        return name
    }


    private enum Meaning: Equatable {
        case clients
        case level
        case process(AudioObjectID)
        case restart
    }

    private struct Listened: Equatable {
        var processes: Set<AudioObjectID> = []
        var defaultOutput: AudioObjectID?
        var defaultInput: AudioObjectID?
        var cameras: Set<CMIOObjectID> = []
    }

    private func listen(processes: [AudioObjectID]?, defaultOutput: AudioObjectID?, defaultInput: AudioObjectID?,
                        cameras: [CMIOObjectID]?) {
        guard let signal else { return }
        var target = listened
        if let processes {
            target.processes = Set(processes)
            target.defaultOutput = defaultOutput
            target.defaultInput = defaultInput
        }
        if let cameras { target.cameras = Set(cameras) }
        guard target != listened || refused || listeners.isEmpty else { return }
        listened = target
        names = names.filter { target.processes.contains($0.key) }

        var wanted: [ListenerKey: Meaning] = [:]
        let audioSystem = UInt32(kAudioObjectSystemObject)
        let global = kAudioObjectPropertyScopeGlobal
        for selector in [kAudioHardwarePropertyProcessObjectList, kAudioHardwarePropertyDefaultOutputDevice,
                         kAudioHardwarePropertyDefaultInputDevice, kAudioHardwarePropertyDevices] {
            wanted[ListenerKey(.audio, audioSystem, selector, global)] = .clients
        }
        wanted[ListenerKey(.audio, audioSystem, kAudioHardwarePropertyServiceRestarted, global)] = .restart
        for process in target.processes {
            for key in Self.processKeys(process) { wanted[key] = .process(process) }
        }
        for (device, scope) in [(target.defaultOutput, kAudioDevicePropertyScopeOutput),
                                (target.defaultInput, kAudioDevicePropertyScopeInput)] {
            guard let device else { continue }
            for selector in [kAudioHardwareServiceDeviceProperty_VirtualMainVolume, kAudioDevicePropertyMute] {
                let key = ListenerKey(.audio, device, selector, scope)
                if system.has(key) { wanted[key] = .level }
            }
        }
        if let input = target.defaultInput {
            wanted[ListenerKey(.audio, input, kAudioDevicePropertyDeviceIsRunningSomewhere, global)] = .clients
        }
        let cameraScope = CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal)
        wanted[ListenerKey(.camera, CMIOObjectID(kCMIOObjectSystemObject),
                           CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices), cameraScope)] = .clients
        for camera in target.cameras {
            wanted[ListenerKey(.camera, camera, CMIOObjectPropertySelector(kCMIODevicePropertyDeviceIsRunningSomewhere),
                               cameraScope)] = .clients
        }

        for key in listeners.keys where wanted[key] == nil {
            system.unlisten(key)
            listeners[key] = nil
        }
        refused = false
        for (key, meaning) in wanted where listeners[key] == nil {
            let heard = heard
            let laid = system.listen(key) {
                switch meaning {
                case .process(let process): heard.mark(process)
                case .restart: heard.markRestart()
                case .clients, .level: break
                }
                signal(meaning == .level ? .level : .clients)
            }
            if laid { listeners[key] = meaning } else { refused = true }
        }
        watched = target.processes.filter { process in Self.processKeys(process).allSatisfy { listeners[$0] != nil } }
        trusted = trusted.filter { watched.contains($0.key) }
    }

    private static func processKeys(_ process: AudioObjectID) -> [ListenerKey] {
        let global = kAudioObjectPropertyScopeGlobal
        return [ListenerKey(.audio, process, kAudioProcessPropertyIsRunningInput, global),
                ListenerKey(.audio, process, kAudioProcessPropertyIsRunningOutput, global),
                ListenerKey(.audio, process, kAudioProcessPropertyDevices, kAudioObjectPropertyScopeInput),
                ListenerKey(.audio, process, kAudioProcessPropertyDevices, kAudioObjectPropertyScopeOutput)]
    }

    private func forgetListeners() {
        for key in listeners.keys { system.unlisten(key) }
        listeners = [:]
        listened = Listened()
        refused = false
        watched = []
        trusted = [:]
        lastInput = nil
        names = [:]
    }
}

private final class Heard: @unchecked Sendable {
    struct Marks {
        var processes: Set<AudioObjectID> = []
        var everything = false
        var restarted = false
    }

    private let lock = NSLock()
    private var marks = Marks()

    func mark(_ process: AudioObjectID) { lock.withLock { _ = marks.processes.insert(process) } }
    func markEverything() { lock.withLock { marks.everything = true } }
    func markRestart() { lock.withLock { marks.everything = true; marks.restarted = true } }

    func take() -> Marks {
        lock.withLock {
            defer { marks = Marks() }
            return marks
        }
    }
}


struct ProcessRunning: Equatable {
    let input: Bool?
    let output: Bool?

    var answered: Bool { input != nil && output != nil }
}

struct ProcessName: Equatable {
    let app: String
    let raw: String
}

struct ListenerKey: Hashable {
    enum System { case audio, camera }

    let system: System
    let object: UInt32
    let selector: UInt32
    let scope: UInt32

    init(_ system: System, _ object: UInt32, _ selector: UInt32, _ scope: UInt32) {
        self.system = system
        self.object = object
        self.selector = selector
        self.scope = scope
    }
}

protocol DeviceSystem: AnyObject, Sendable {
    func processes() -> [AudioObjectID]?
    func running(_ process: AudioObjectID) -> ProcessRunning
    func pid(_ process: AudioObjectID) -> pid_t?
    func name(_ process: AudioObjectID, pid: pid_t) -> ProcessName
    func devices(_ process: AudioObjectID, scope: AudioObjectPropertyScope) -> [AudioDeviceFacts]
    func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioObjectID?
    func level(_ device: AudioObjectID?, scope: AudioObjectPropertyScope) -> DeviceLevel
    func runningSomewhere(_ device: AudioObjectID) -> Bool
    func cameras() -> (all: [CMIOObjectID], running: [CameraFacts])?
    func has(_ key: ListenerKey) -> Bool
    func listen(_ key: ListenerKey, _ heard: @escaping @Sendable () -> Void) -> Bool
    func unlisten(_ key: ListenerKey)
}

final class MacDeviceSystem: DeviceSystem, @unchecked Sendable {
    private let listenerQueue = DispatchQueue(label: "org.lifestreamprotocol.device-use.listeners")
    private var audioBlocks: [ListenerKey: AudioObjectPropertyListenerBlock] = [:]
    private var cameraBlocks: [ListenerKey: CMIOObjectPropertyListenerBlock] = [:]

    func processes() -> [AudioObjectID]? {
        Audio.objects(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList)
    }

    func running(_ process: AudioObjectID) -> ProcessRunning {
        ProcessRunning(input: Audio.uint32(process, kAudioProcessPropertyIsRunningInput).map { $0 == 1 },
                       output: Audio.uint32(process, kAudioProcessPropertyIsRunningOutput).map { $0 == 1 })
    }

    func pid(_ process: AudioObjectID) -> pid_t? { Audio.pid(process) }

    func name(_ process: AudioObjectID, pid: pid_t) -> ProcessName {
        let raw = Audio.string(process, kAudioProcessPropertyBundleID).flatMap { $0.isEmpty ? nil : $0 }
            ?? Owner.executableName(pid).map { "proc:\($0)" } ?? "unknown"
        return ProcessName(app: Owner.app(of: pid) ?? raw, raw: raw)
    }

    func devices(_ process: AudioObjectID, scope: AudioObjectPropertyScope) -> [AudioDeviceFacts] {
        (Audio.objects(process, kAudioProcessPropertyDevices, scope: scope) ?? []).compactMap(Audio.facts)
    }

    func defaultDevice(_ selector: AudioObjectPropertySelector) -> AudioObjectID? {
        Audio.device(AudioObjectID(kAudioObjectSystemObject), selector)
    }

    func level(_ device: AudioObjectID?, scope: AudioObjectPropertyScope) -> DeviceLevel {
        Audio.level(device, scope: scope)
    }

    func runningSomewhere(_ device: AudioObjectID) -> Bool {
        Audio.uint32(device, kAudioDevicePropertyDeviceIsRunningSomewhere) == 1
    }

    func cameras() -> (all: [CMIOObjectID], running: [CameraFacts])? {
        guard let devices = Camera.objects() else { return nil }
        let running = devices.compactMap { device -> CameraFacts? in
            guard Camera.running(device), let uid = Camera.string(device, kCMIODevicePropertyDeviceUID) else { return nil }
            return CameraFacts(uid: uid, name: Camera.string(device, kCMIOObjectPropertyName))
        }
        return (devices, running)
    }

    func has(_ key: ListenerKey) -> Bool {
        var address = Self.audioAddress(key)
        return AudioObjectHasProperty(key.object, &address)
    }

    func listen(_ key: ListenerKey, _ heard: @escaping @Sendable () -> Void) -> Bool {
        switch key.system {
        case .audio:
            let block: AudioObjectPropertyListenerBlock = { _, _ in heard() }
            var address = Self.audioAddress(key)
            guard AudioObjectAddPropertyListenerBlock(key.object, &address, listenerQueue, block) == noErr else { return false }
            audioBlocks[key] = block
        case .camera:
            let block: CMIOObjectPropertyListenerBlock = { _, _ in heard() }
            var address = Self.cameraAddress(key)
            guard CMIOObjectAddPropertyListenerBlock(key.object, &address, listenerQueue, block) == noErr else { return false }
            cameraBlocks[key] = block
        }
        return true
    }

    func unlisten(_ key: ListenerKey) {
        if let block = audioBlocks.removeValue(forKey: key) {
            var address = Self.audioAddress(key)
            AudioObjectRemovePropertyListenerBlock(key.object, &address, listenerQueue, block)
        }
        if let block = cameraBlocks.removeValue(forKey: key) {
            var address = Self.cameraAddress(key)
            CMIOObjectRemovePropertyListenerBlock(key.object, &address, listenerQueue, block)
        }
    }

    private static func audioAddress(_ key: ListenerKey) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: key.selector, mScope: key.scope, mElement: kAudioObjectPropertyElementMain)
    }

    private static func cameraAddress(_ key: ListenerKey) -> CMIOObjectPropertyAddress {
        CMIOObjectPropertyAddress(mSelector: key.selector, mScope: key.scope,
                                  mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    }
}


private enum Audio {
    static func address(_ selector: AudioObjectPropertySelector,
                        _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    static func objects(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
                        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> [AudioObjectID]? {
        var address = address(selector, scope)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(object, &address, 0, nil, &size) == noErr else { return nil }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard !ids.isEmpty else { return [] }
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &ids) == noErr else { return nil }
        return Array(ids.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
    }

    static func uint32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
                       scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> UInt32? {
        var address = address(selector, scope)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr else { return nil }
        return value
    }

    static func pid(_ process: AudioObjectID) -> pid_t? {
        var address = address(kAudioProcessPropertyPID)
        var value: pid_t = 0
        var size = UInt32(MemoryLayout<pid_t>.size)
        guard AudioObjectGetPropertyData(process, &address, 0, nil, &size, &value) == noErr, value > 0 else { return nil }
        return value
    }

    static func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }

    static func device(_ system: AudioObjectID, _ selector: AudioObjectPropertySelector) -> AudioObjectID? {
        guard let device = uint32(system, selector), device != kAudioObjectUnknown else { return nil }
        return device
    }

    static func facts(_ device: AudioObjectID) -> AudioDeviceFacts? {
        guard let uid = string(device, kAudioDevicePropertyDeviceUID) else { return nil }
        return AudioDeviceFacts(uid: uid, name: string(device, kAudioObjectPropertyName),
                                transport: transport(uint32(device, kAudioDevicePropertyTransportType)))
    }

    static func level(_ device: AudioObjectID?, scope: AudioObjectPropertyScope) -> DeviceLevel {
        DeviceLevel(device: device.flatMap(facts), volume: device.flatMap { volume($0, scope: scope) },
                    muted: device.flatMap { muted($0, scope: scope) })
    }

    static func volume(_ device: AudioObjectID, scope: AudioObjectPropertyScope) -> Double? {
        var address = address(kAudioHardwareServiceDeviceProperty_VirtualMainVolume, scope)
        guard AudioObjectHasProperty(device, &address) else { return nil }
        var value: Float32 = 0
        var size = UInt32(MemoryLayout<Float32>.size)
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &value) == noErr, value.isFinite else { return nil }
        return Double(min(max(value, 0), 1))
    }

    static func muted(_ device: AudioObjectID, scope: AudioObjectPropertyScope) -> Bool? {
        var address = address(kAudioDevicePropertyMute, scope)
        guard AudioObjectHasProperty(device, &address) else { return nil }
        return uint32(device, kAudioDevicePropertyMute, scope: scope).map { $0 != 0 }
    }

    static func transport(_ value: UInt32?) -> String {
        switch value {
        case kAudioDeviceTransportTypeBuiltIn: return "built_in"
        case kAudioDeviceTransportTypeBluetooth: return "bluetooth"
        case kAudioDeviceTransportTypeBluetoothLE: return "bluetooth_le"
        case kAudioDeviceTransportTypeUSB: return "usb"
        case kAudioDeviceTransportTypeAirPlay: return "airplay"
        case kAudioDeviceTransportTypeHDMI: return "hdmi"
        case kAudioDeviceTransportTypeDisplayPort: return "displayport"
        case kAudioDeviceTransportTypeThunderbolt: return "thunderbolt"
        case kAudioDeviceTransportTypePCI: return "pci"
        case kAudioDeviceTransportTypeFireWire: return "firewire"
        case kAudioDeviceTransportTypeAVB: return "avb"
        case kAudioDeviceTransportTypeContinuityCaptureWired, kAudioDeviceTransportTypeContinuityCaptureWireless:
            return "continuity"
        case kAudioDeviceTransportTypeVirtual: return "virtual"
        case kAudioDeviceTransportTypeAggregate, kAudioDeviceTransportTypeAutoAggregate: return "aggregate"
        default: return "unknown"
        }
    }
}


private enum Camera {
    static func address(_ selector: Int) -> CMIOObjectPropertyAddress {
        CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(selector),
                                  mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
                                  mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    }

    static func objects() -> [CMIOObjectID]? {
        var address = address(kCMIOHardwarePropertyDevices)
        let system = CMIOObjectID(kCMIOObjectSystemObject)
        var size: UInt32 = 0
        guard CMIOObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else { return nil }
        var ids = [CMIOObjectID](repeating: 0, count: Int(size) / MemoryLayout<CMIOObjectID>.size)
        guard !ids.isEmpty else { return [] }
        var used: UInt32 = 0
        guard CMIOObjectGetPropertyData(system, &address, 0, nil, size, &used, &ids) == noErr else { return nil }
        return Array(ids.prefix(Int(used) / MemoryLayout<CMIOObjectID>.size))
    }

    static func running(_ device: CMIOObjectID) -> Bool {
        var address = address(kCMIODevicePropertyDeviceIsRunningSomewhere)
        var value: UInt32 = 0
        var used: UInt32 = 0
        guard CMIOObjectGetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &used, &value) == noErr
        else { return false }
        return value != 0
    }

    static func string(_ device: CMIOObjectID, _ selector: Int) -> String? {
        var address = address(selector)
        var value: Unmanaged<CFString>?
        var used: UInt32 = 0
        let size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        guard CMIOObjectGetPropertyData(device, &address, 0, nil, size, &used, &value) == noErr, let value else { return nil }
        return value.takeRetainedValue() as String
    }
}


private enum Owner {
    private typealias Responsible = @convention(c) (pid_t) -> pid_t

    private static let responsible: Responsible? = {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid")
        else { return nil }
        return unsafeBitCast(symbol, to: Responsible.self)
    }()

    static func app(of pid: pid_t) -> String? {
        if let id = visibleApp(pid) { return id }
        if let responsible, case let owner = responsible(pid), owner > 1, owner != pid, let id = visibleApp(owner) {
            return id
        }
        var current = pid
        for _ in 0..<8 {
            guard let parent = parent(of: current), parent > 1 else { return nil }
            if let id = visibleApp(parent) { return id }
            current = parent
        }
        return nil
    }

    private static func visibleApp(_ pid: pid_t) -> String? {
        guard let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy != .prohibited else { return nil }
        return app.bundleIdentifier
    }

    private static func parent(of pid: pid_t) -> pid_t? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        guard sysctl(&name, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        return info.kp_eproc.e_ppid
    }

    static func executableName(_ pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 256)
        guard proc_name(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        let name = String(cString: buffer)
        return name.isEmpty ? nil : name
    }
}
