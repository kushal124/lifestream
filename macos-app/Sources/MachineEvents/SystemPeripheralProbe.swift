import AppKit
import CoreBluetooth
import Evidence
import Foundation
import IOBluetooth
import IOKit

final class SystemPeripheralProbe: NSObject, PeripheralProbe, @unchecked Sendable {
    private let lightSensor: io_service_t
    static let settle: TimeInterval = 2
    private var queue: DispatchQueue?
    private var changed: ((PeripheralSignal) -> Void)?
    private var displaysFirstHeardAt: Date?
    private var connectNotification: IOBluetoothUserNotification?
    private var disconnectNotifications: [String: IOBluetoothUserNotification] = [:]

    override init() {
        lightSensor = IOServiceGetMatchingService(kIOMainPortDefault, ["IOPropertyExistsMatch": "CurrentLux"] as CFDictionary)
        super.init()
    }

    deinit {
        if lightSensor != 0 { IOObjectRelease(lightSensor) }
    }

    func start(queue: DispatchQueue, changed: @escaping (PeripheralSignal) -> Void) -> Peripherals {
        dispatchPrecondition(condition: .onQueue(.main))
        self.queue = queue
        self.changed = changed
        CGDisplayRegisterReconfigurationCallback(Self.reconfigured, Unmanaged.passUnretained(self).toOpaque())
        if Self.bluetoothAllowed {
            connectNotification = IOBluetoothDevice.register(forConnectNotifications: self,
                                                             selector: #selector(connected(_:device:)))
        }
        return ResourceMeter.shared.measure(.machineEvents) {
            Peripherals(displays: Self.displays(), bluetooth: connectedDevices(), lux: lux())
        }
    }

    func stop() {
        dispatchPrecondition(condition: .onQueue(.main))
        CGDisplayRemoveReconfigurationCallback(Self.reconfigured, Unmanaged.passUnretained(self).toOpaque())
        connectNotification?.unregister()
        connectNotification = nil
        for notification in disconnectNotifications.values { notification.unregister() }
        disconnectNotifications = [:]
        changed = nil
        queue = nil
    }

    func lux() -> Double? {
        guard lightSensor != 0,
              let value = IORegistryEntryCreateCFProperty(lightSensor, "CurrentLux" as CFString,
                                                         kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber
        else { return nil }
        return value.doubleValue
    }


    private static let reconfigured: CGDisplayReconfigurationCallBack = { _, flags, context in
        guard let context, !flags.contains(.beginConfigurationFlag) else { return }
        let probe = Unmanaged<SystemPeripheralProbe>.fromOpaque(context).takeUnretainedValue()
        let at = Date()
        DispatchQueue.main.async { probe.displaysChanged(at: at) }
    }

    private func displaysChanged(at: Date) {
        guard changed != nil, displaysFirstHeardAt == nil else { return }
        displaysFirstHeardAt = at
        DispatchQueue.main.async { [self] in
            displaysFirstHeardAt = nil
            guard let displays = ResourceMeter.shared.measure(.machineEvents, Self.displays) else { return }
            send(.displays(displays, at: at))
        }
    }

    private static func displays() -> [DisplayFacts]? {
        var count: UInt32 = 0
        guard CGGetOnlineDisplayList(0, nil, &count) == .success else { return nil }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetOnlineDisplayList(count, &ids, &count) == .success else { return nil }
        var names: [CGDirectDisplayID: String] = [:]
        for screen in NSScreen.screens {
            guard let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { continue }
            names[number.uint32Value] = screen.localizedName
        }
        return ids.prefix(Int(count)).sorted().map { id in
            let bounds = CGDisplayBounds(id)
            let mode = CGDisplayCopyDisplayMode(id)
            let size = CGDisplayScreenSize(id)
            let mirrored = CGDisplayMirrorsDisplay(id)
            return DisplayFacts(id: id, name: names[id], builtIn: CGDisplayIsBuiltin(id) != 0,
                                main: CGDisplayIsMain(id) != 0,
                                x: bounds.origin.x, y: bounds.origin.y, width: bounds.width, height: bounds.height,
                                pixelWidth: mode?.pixelWidth, pixelHeight: mode?.pixelHeight,
                                widthMM: size.width > 0 ? size.width : nil, heightMM: size.height > 0 ? size.height : nil,
                                mirrorOf: mirrored == kCGNullDirectDisplay ? nil : mirrored)
        }
    }


    private static var bluetoothAllowed: Bool { CBManager.authorization == .allowedAlways }

    private func connectedDevices() -> [BluetoothFacts]? {
        guard Self.bluetoothAllowed else { return nil }
        let paired = IOBluetoothDevice.pairedDevices() as? [IOBluetoothDevice] ?? []
        return paired.filter { $0.isConnected() }.map { device in
            listenForDisconnect(device)
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.settle) { [weak self] in
                guard let self, !device.isConnected() else { return }
                self.disconnectNotifications.removeValue(forKey: Self.facts(device).identity)?.unregister()
                self.send(.disconnected(Self.facts(device), at: Date()))
            }
            return Self.facts(device)
        }
    }

    @objc private func connected(_ notification: IOBluetoothUserNotification, device: IOBluetoothDevice) {
        let at = Date()
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.settle) { [weak self] in
            guard let self, device.isConnected() else { return }
            self.listenForDisconnect(device)
            self.send(.connected(Self.facts(device), at: at))
        }
    }

    @objc private func disconnected(_ notification: IOBluetoothUserNotification, device: IOBluetoothDevice) {
        let facts = Self.facts(device)
        disconnectNotifications.removeValue(forKey: facts.identity)?.unregister()
        send(.disconnected(facts, at: Date()))
    }

    private func listenForDisconnect(_ device: IOBluetoothDevice) {
        let identity = Self.facts(device).identity
        guard disconnectNotifications[identity] == nil,
              let notification = device.register(forDisconnectNotification: self,
                                                 selector: #selector(disconnected(_:device:))) else { return }
        disconnectNotifications[identity] = notification
    }

    private static func facts(_ device: IOBluetoothDevice) -> BluetoothFacts {
        BluetoothFacts(address: device.addressString, name: device.name, classOfDevice: device.classOfDevice)
    }

    private func send(_ signal: PeripheralSignal) {
        guard let queue, let changed else { return }
        queue.async { changed(signal) }
    }
}
