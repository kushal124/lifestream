import Foundation
import SQLite3
import zlib

final class PowerLogFixture {
    static let coalitionTable = """
        CREATE TABLE 'PLCoalitionAgent_EventInterval_CoalitionInterval' (
        'ID' INTEGER PRIMARY KEY AUTOINCREMENT, 'timestamp' REAL, 'BundleId' TEXT,
        'LaunchdCoalitionId' INTEGER, 'LaunchdName' TEXT, 'ane_energy_nj' INTEGER, 'ane_time' REAL,
        'bytesread' REAL, 'byteswritten' REAL, 'cpu_cycles' INTEGER, 'cpu_instructions' INTEGER,
        'cpu_pcycles' INTEGER, 'cpu_pinstructions' INTEGER, 'cpu_ptime' REAL, 'cpu_time' REAL,
        'cpu_time_billed_to_me' REAL, 'cpu_time_billed_to_others' REAL, 'cpu_time_eqos_0' REAL,
        'cpu_time_eqos_1' REAL, 'cpu_time_eqos_2' REAL, 'cpu_time_eqos_3' REAL, 'cpu_time_eqos_4' REAL,
        'cpu_time_eqos_5' REAL, 'cpu_time_eqos_6' REAL, 'energy' INTEGER, 'energy_billed_to_me' INTEGER,
        'energy_billed_to_others' INTEGER, 'gpu_energy_nj' INTEGER, 'gpu_energy_nj_billed_to_me' INTEGER,
        'gpu_energy_nj_billed_to_others' INTEGER, 'gpu_time' REAL, 'interrupt_wakeups' REAL,
        'logical_deferred_writes' REAL, 'logical_immediate_writes' REAL, 'logical_invalidated_writes' REAL,
        'logical_metadata_writes' REAL, 'platform_idle_wakeups' REAL, 'tasks_exited' REAL,
        'tasks_started' REAL, 'time_nonempty' REAL, 'timestampEnd' REAL)
        """
    static let batteryTable = """
        CREATE TABLE 'PLBatteryAgent_EventBackward_Battery' (
        'ID' INTEGER PRIMARY KEY AUTOINCREMENT, 'timestamp' REAL, 'Level' REAL, 'RawLevel' REAL,
        'AtCriticalLevel' INTEGER, 'Voltage' INTEGER, 'AppleRawBatteryVoltage' INTEGER,
        'AdapterVoltage' INTEGER, 'InstantAmperage' INTEGER, 'FullAvailableCapacity' INTEGER,
        'CurrentCapacity' INTEGER, 'AppleRawCurrentCapacity' INTEGER, 'MaxCapacity' INTEGER,
        'AppleRawMaxCapacity' INTEGER, 'DesignCapacity' INTEGER, 'CycleCount' INTEGER, 'ChargeStatus' TEXT,
        'IsCharging' INTEGER, 'FullyCharged' INTEGER, 'Amperage' INTEGER, 'Temperature' REAL,
        'AdapterInfo' INTEGER, 'ExternalConnected' INTEGER, 'ChemID' INTEGER, 'AbsoluteCapacity' INTEGER,
        'PresentDOD' INTEGER, 'QmaxCell0' INTEGER, 'QmaxCell1' INTEGER, 'QmaxCell2' INTEGER,
        'AbsoluteLevel' REAL, 'PMUConfiguration' INTEGER, 'DOD0' INTEGER, 'DOD1' INTEGER, 'DOD2' INTEGER,
        'PassedCharge' INTEGER, 'Qstart' INTEGER, 'ResScale' INTEGER, 'RSS' INTEGER,
        'ITMiscStatus' INTEGER, 'PresentMaxRa0-8' INTEGER, 'LifetimeMaxRa0-8Updated' INTEGER,
        'Flags' INTEGER, 'BatteryCellDisconnectCount' INTEGER, 'GaugeResetCounter' INTEGER,
        'ChemicalWeightedRa' INTEGER, 'WeightedRa' INTEGER, 'BatteryHealthMetric' INTEGER,
        'PeakPerformanceCapacity' INTEGER, 'QmaxDisqualificationReason' INTEGER, 'SimRate' INTEGER,
        'ChargeAccum' INTEGER, 'FilteredCurrent' INTEGER, 'VacVoltageLimit' INTEGER,
        'KioskModeHighSocSeconds' INTEGER, 'KioskModeMode' INTEGER, 'CurrentSenseMonitorStatus' INTEGER,
        'AdapterPower' REAL, 'AverageAmperage' INTEGER, 'BatteryRsenseOpenCount' INTEGER,
        'CellVoltage0' INTEGER, 'CellVoltage1' INTEGER, 'CellVoltage2' INTEGER, 'ChargerAlert' INTEGER,
        'ChargerInhibitReason' INTEGER, 'ChargerRegisterStatus' BLOB, 'ChargerResetCounter' INTEGER,
        'ChargerStatus' INTEGER, 'ChargingCurrent' INTEGER, 'ChargingVoltage' INTEGER, 'DODatEOC' INTEGER,
        'Dod0AtQualifiedQmax' INTEGER, 'DynamicEntryStatus' INTEGER, 'IdealCRate' REAL,
        'InductiveFWMode' INTEGER, 'LPEMMode' INTEGER, 'NominalChargeCapacity' INTEGER,
        'NotChargingReason' INTEGER, 'OCV' INTEGER, 'OCVCount' INTEGER, 'PMUConfigured' REAL,
        'Port1Current' INTEGER, 'Port1FilteredPower' INTEGER, 'Port1Power' INTEGER, 'Port1Voltage' INTEGER,
        'PresentDODCell1' INTEGER, 'PresentDODCell2' INTEGER, 'QmaxUpdateDisqualified' INTEGER,
        'RaUpdateDisqualified' INTEGER, 'SOC1Voltage' INTEGER, 'SOCAlarm' INTEGER, 'SOCFThreshold' INTEGER,
        'SWRawFCC' INTEGER, 'SWRawSOC' INTEGER, 'SWRemCap' INTEGER, 'ShallowDischargeFlag' INTEGER,
        'ShallowDischargeLevels' INTEGER, 'ShallowDischargeScore' INTEGER, 'SlowChargingReason' INTEGER,
        'SystemPower' REAL, 'TLCDuration' INTEGER, 'TimeSinceLastOCV' INTEGER,
        'VirtualTemperature' INTEGER)
        """

    let url: URL
    private var handle: OpaquePointer?

    init(_ url: URL) throws {
        self.url = url
        guard sqlite3_open(url.path, &handle) == SQLITE_OK else { throw FixtureError.sqlite }
        try execute("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        try execute(Self.coalitionTable + ";" + Self.batteryTable + ";")
    }

    deinit { close() }

    func close() {
        if let handle { sqlite3_close(handle) }
        handle = nil
    }

    func execute(_ sql: String) throws {
        guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else { throw FixtureError.sqlite }
    }

    func coalition(id: Int, start: Double, end: Double, bundle: String?, energy: Int, ane: Int = 0, gpu: Int = 0,
                   billed: Int = 0, cpu: Double = 0) throws {
        let bundleValue = bundle.map { "'\($0)'" } ?? "NULL"
        try execute("""
            INSERT INTO PLCoalitionAgent_EventInterval_CoalitionInterval
            (ID, timestamp, timestampEnd, BundleId, LaunchdName, energy, ane_energy_nj, gpu_energy_nj,
             energy_billed_to_me, cpu_time, interrupt_wakeups)
            VALUES (\(id), \(start), \(end), \(bundleValue), 'application.synthetic.\(id)', \(energy), \(ane), \(gpu),
                    \(billed), \(cpu), 10.0)
            """)
    }

    func battery(id: Int, at: Double, systemPower: Double, external: Bool) throws {
        try execute("""
            INSERT INTO PLBatteryAgent_EventBackward_Battery
            (ID, timestamp, Level, Voltage, InstantAmperage, ExternalConnected, SystemPower, ChargerRegisterStatus)
            VALUES (\(id), \(at), 80.0, 12000, -1000, \(external ? 1 : 0), \(systemPower), x'00ff')
            """)
    }

    static func archive(_ build: (PowerLogFixture) throws -> Void, to destination: URL, scratch: URL) throws {
        let plain = scratch.appendingPathComponent(UUID().uuidString + ".PLSQL")
        let database = try PowerLogFixture(plain)
        try build(database)
        try database.execute("PRAGMA wal_checkpoint(TRUNCATE);")
        database.close()
        let bytes = try Data(contentsOf: plain)
        guard let output = gzopen(destination.path, "wb") else { throw FixtureError.gzip }
        let written = bytes.withUnsafeBytes { gzwrite(output, $0.baseAddress, UInt32($0.count)) }
        gzclose(output)
        guard written == bytes.count else { throw FixtureError.gzip }
        for suffix in ["", "-wal", "-shm"] { try? FileManager.default.removeItem(atPath: plain.path + suffix) }
    }
}

enum FixtureError: Error {
    case sqlite
    case gzip
}
