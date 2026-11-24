
export const EXPORT_AT = "2026-10-03T12:00:00+05:30";
export const SOURCE = "apple-health:synthetic-account:cloud";

const DOCTYPE = `<!DOCTYPE HealthData [
<!-- HealthKit Export Version: 14 -->
<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout|ActivitySummary|ClinicalRecord|Audiogram|VisionPrescription)*)>
<!ATTLIST HealthData
  locale CDATA #REQUIRED
>
<!ELEMENT ExportDate EMPTY>
<!ATTLIST ExportDate
  value CDATA #REQUIRED
>
<!ELEMENT Record ((MetadataEntry|HeartRateVariabilityMetadataList)*)>
<!ATTLIST Record
  type          CDATA #REQUIRED
  unit          CDATA #IMPLIED
  value         CDATA #IMPLIED
  device        CDATA #IMPLIED
>
]>`;

const WATCH = "&lt;&lt;HKDevice: 0x600002d1c0f0&gt;, name:Synthetic Watch, manufacturer:Synthetic Maker, model:Watch, hardware:SyntheticWatch1,1, software:9.1&gt;";
const PHONE = "&lt;&lt;HKDevice: 0x600002d1c0f1&gt;, name:Synthetic Phone, manufacturer:Synthetic Maker, model:iPhone, hardware:SyntheticPhone9,9, software:9.1&gt;";

const record = (attributes: Record<string, string>, children = ""): string => {
  const text = Object.entries(attributes).map(([name, value]) => `${name}="${value}"`).join(" ");
  return children === "" ? ` <Record ${text}/>\n` : ` <Record ${text}>\n${children} </Record>\n`;
};
const meta = (key: string, value: string): string => `  <MetadataEntry key="${key}" value="${value}"/>\n`;

export function exportRecords(): string {
  return [
    record(
      { type: "HKQuantityTypeIdentifierHeartRate", sourceName: "Synthetic Wätch ✓", sourceVersion: "9.1", device: WATCH, unit: "count/min", creationDate: "2026-10-03 08:31:00 +0530", startDate: "2026-10-03 08:30:00 +0530", endDate: "2026-10-03 08:30:00 +0530", value: "72" },
      meta("HKMetadataKeyHeartRateMotionContext", "0"),
    ),
    record({ type: "HKQuantityTypeIdentifierStepCount", sourceName: "Synthetic Phone", sourceVersion: "9.1", device: PHONE, unit: "count", creationDate: "2026-10-03 08:40:00 +0530", startDate: "2026-10-03 08:30:00 +0530", endDate: "2026-10-03 08:39:59 +0530", value: "120" }),
    record(
      { type: "HKQuantityTypeIdentifierActiveEnergyBurned", sourceName: "Synthetic Wätch ✓", sourceVersion: "9.1", device: WATCH, unit: "Cal", creationDate: "2026-10-03 08:41:00 +0530", startDate: "2026-10-03 08:40:00 +0530", endDate: "2026-10-03 08:41:00 +0530", value: "1.2345678" },
      meta("HKWasUserEntered", "1") + meta("HKMetadataKeySyncVersion", "2"),
    ),
    record({ type: "HKQuantityTypeIdentifierWalkingSpeed", sourceName: "Synthetic Phone", sourceVersion: "9.1", unit: "mi/hr", creationDate: "2026-10-03 08:42:00 +0530", startDate: "2026-10-03 08:41:00 +0530", endDate: "2026-10-03 08:41:09 +0530", value: "2.5" }),
    record({ type: "HKQuantityTypeIdentifierWalkingStepLength", sourceName: "Synthetic Phone", sourceVersion: "9.1", unit: "in", creationDate: "2026-10-03 08:42:00 +0530", startDate: "2026-10-03 08:41:00 +0530", endDate: "2026-10-03 08:41:09 +0530", value: "27.5" }),
    record({ type: "HKQuantityTypeIdentifierOxygenSaturation", sourceName: "Synthetic Wätch ✓", sourceVersion: "9.1", unit: "%", creationDate: "2026-10-03 03:00:00 +0000", startDate: "2026-10-03 03:00:00 +0000", endDate: "2026-10-03 03:00:00 +0000", value: "0.97" }),
    record(
      { type: "HKCategoryTypeIdentifierSleepAnalysis", sourceName: "Synthetic Wätch ✓", sourceVersion: "9.1", creationDate: "2026-10-03 07:00:00 +0530", startDate: "2026-10-03 01:30:00 +0530", endDate: "2026-10-03 03:00:00 +0530", value: "HKCategoryValueSleepAnalysisAsleepCore" },
      meta("HKTimeZone", "Etc/GMT-3").replace("HKTimeZone", "HKMetadataKeyTimeZone"),
    ),
    record(
      { type: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", sourceName: "Synthetic Wätch ✓", sourceVersion: "9.1", device: WATCH, unit: "ms", creationDate: "2026-10-03 08:50:00 +0530", startDate: "2026-10-03 08:49:00 +0530", endDate: "2026-10-03 08:50:00 +0530", value: "41.23456789" },
      '  <HeartRateVariabilityMetadataList>\n   <InstantaneousBeatsPerMinute bpm="71" time="8:49:01.50 AM"/>\n  </HeartRateVariabilityMetadataList>\n',
    ),
    ` <Record type='HKQuantityTypeIdentifierFlightsClimbed' sourceName='Synthetic &amp; Co' unit='count' creationDate='2026-10-03 09:00:00 +0530' startDate='2026-10-03 08:55:00 +0530' endDate='2026-10-03 08:56:00 +0530' value='2'/>\n`,
  ].join("");
}

export function exportXml(records = exportRecords()): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n${DOCTYPE}\n<HealthData locale="en_US">\n` +
    ` <ExportDate value="2026-10-03 12:00:00 +0530"/>\n` +
    ` <Me HKCharacteristicTypeIdentifierDateOfBirth="1990-01-01" HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexNotSet" HKCharacteristicTypeIdentifierBloodType="HKBloodTypeOPositive" HKCharacteristicTypeIdentifierFitzpatrickSkinType="HKFitzpatrickSkinTypeNotSet" HKCharacteristicTypeIdentifierCardioFitnessMedicationsUse="None"/>\n` +
    records +
    ` <!-- a comment between records -->\n` +
    ` <Correlation type="HKCorrelationTypeIdentifierBloodPressure" sourceName="Synthetic Cuff" creationDate="2026-10-03 09:00:00 +0530" startDate="2026-10-03 09:00:00 +0530" endDate="2026-10-03 09:00:00 +0530">\n` +
    `  <Record type="HKQuantityTypeIdentifierBloodPressureSystolic" sourceName="Synthetic Cuff" unit="mmHg" startDate="2026-10-03 09:00:00 +0530" endDate="2026-10-03 09:00:00 +0530" value="118"/>\n` +
    ` </Correlation>\n` +
    ` <Workout workoutActivityType="HKWorkoutActivityTypeWalking" duration="30" durationUnit="min" sourceName="Synthetic Wätch ✓" startDate="2026-10-03 07:00:00 +0530" endDate="2026-10-03 07:30:00 +0530">\n` +
    `  <WorkoutEvent type="HKWorkoutEventTypeSegment" date="2026-10-03 07:00:00 +0530"/>\n` +
    `  <WorkoutRoute sourceName="Synthetic Wätch ✓"><FileReference path="/workout-routes/route_2026-10-03_7.00am.gpx"/></WorkoutRoute>\n` +
    ` </Workout>\n` +
    ` <ActivitySummary dateComponents="2026-10-02" activeEnergyBurned="512.25" activeEnergyBurnedGoal="600" activeEnergyBurnedUnit="Cal" appleMoveTime="0" appleMoveTimeGoal="0" appleExerciseTime="31" appleExerciseTimeGoal="30" appleStandHours="10" appleStandHoursGoal="12"/>\n` +
    ` <ActivitySummary dateComponents="2026-10-03" activeEnergyBurned="101.123456789" activeEnergyBurnedGoal="600" activeEnergyBurnedUnit="kcal" appleMoveTime="0" appleMoveTimeGoal="0" appleExerciseTime="5" appleExerciseTimeGoal="30" appleStandHours="2" appleStandHoursGoal="12"/>\n` +
    `</HealthData>\n`
  );
}

export function fillerRecord(n: number): string {
  const minute = (n: number) => {
    const at = new Date(Date.UTC(2026, 9, 3) + n * 60_000).toISOString();
    return `${at.slice(0, 10)} ${at.slice(11, 19)} +0000`;
  };
  return record({ type: "HKQuantityTypeIdentifierStepCount", sourceName: "Synthetic Phone", sourceVersion: "9.1", device: PHONE, unit: "count", creationDate: minute(n + 1), startDate: minute(n), endDate: minute(n + 1), value: String(n % 500) }, meta("HKWasUserEntered", "0"));
}
