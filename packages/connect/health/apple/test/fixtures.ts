import { join } from "node:path";
import type { Fixture } from "../../../test/drive.js";
import { writeZip } from "../../../test/drive.js";
import { EXPORT_AT, exportXml } from "../health.test-support.js";

export const healthExportFixture: Fixture = (folder) => {
  writeZip(join(folder, "export.zip"), [{ name: "apple_health_export/export.xml", bytes: Buffer.from(exportXml()), method: "deflate" }]);
  return {
    source: "apple-health:synthetic-account:cloud", facts: { exported_at: EXPORT_AT }, files: { "export.zip": "trust" },
    heads: [
      "characteristic HKCharacteristicTypeIdentifierBiologicalSex", "characteristic HKCharacteristicTypeIdentifierBloodType",
      "characteristic HKCharacteristicTypeIdentifierCardioFitnessMedicationsUse", "characteristic HKCharacteristicTypeIdentifierDateOfBirth",
      "characteristic HKCharacteristicTypeIdentifierFitzpatrickSkinType", "day-summary 20261002", "day-summary 20261003", "sample 223e32a2ef3f", "sample 2bb17c5ec3c3", "sample 2f9a7ae46755",
      "sample 41c21d13a108", "sample 5ae958dced73", "sample 63e9d56fdf37", "sample 9267efbce18f", "sample 9efec8eda60c", "sample b9c70d2d117a",
      "sample f85dc8a8467e", "workout 89a426f3c55c",
    ],
  };
};
