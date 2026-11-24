-- A synthetic store written by the home connector's own fixture builder
-- (packages/connect/browser/safari/test/fixture.ts), dumped, read by the Mac domain's tests and sealed
-- into the connector's changes fixture (packages/connect/browser/safari/test/changes-bundle.zip).
-- Every value is fake.
CREATE TABLE cloud_tab_devices (device_uuid TEXT PRIMARY KEY NOT NULL,system_fields BLOB NOT NULL,device_name TEXT,device_type_identifier TEXT,has_duplicate_device_name BOOLEAN DEFAULT 0,is_ephemeral_device BOOLEAN DEFAULT 0,last_modified REAL NOT NULL);
INSERT INTO cloud_tab_devices VALUES('SYNTH-DEVICE-0001',X'01','Synthetic Phone','com.example.phone',0,0,811584000.0);
CREATE TABLE cloud_tabs (tab_uuid TEXT PRIMARY KEY NOT NULL,system_fields BLOB NOT NULL,device_uuid TEXT NOT NULL,position BLOB NOT NULL,title TEXT,url TEXT NOT NULL,is_showing_reader BOOLEAN DEFAULT 0,is_pinned BOOLEAN DEFAULT 0,reader_scroll_position_page_index INTEGER,scene_id TEXT,last_viewed_time REAL DEFAULT 0,FOREIGN KEY(device_uuid) REFERENCES cloud_tab_devices(device_uuid) ON DELETE CASCADE);
INSERT INTO cloud_tabs VALUES('SYNTH-TAB-0001',X'02','SYNTH-DEVICE-0001',X'03','Tab One','https://example.com/one',0,0,NULL,'scene-1',811584100.0);
INSERT INTO cloud_tabs VALUES('SYNTH-TAB-0002',X'02','SYNTH-DEVICE-0001',X'03','Tab Two','https://example.com/two',0,1,NULL,'scene-1',0.0);
CREATE TABLE cloud_tab_close_requests (close_request_uuid TEXT PRIMARY KEY NOT NULL,system_fields BLOB NOT NULL,destination_device_uuid TEXT NOT NULL,url TEXT NOT NULL,tab_uuid TEXT NOT NULL,FOREIGN KEY(destination_device_uuid) REFERENCES cloud_tab_devices(device_uuid) ON DELETE CASCADE);
INSERT INTO cloud_tab_close_requests VALUES('SYNTH-CLOSE-0001',X'04','SYNTH-DEVICE-0001','https://example.com/one','SYNTH-TAB-0001');
CREATE TABLE metadata (key TEXT NOT NULL UNIQUE, value);
CREATE INDEX cloud_tabs__device_uuid ON cloud_tabs (device_uuid);
