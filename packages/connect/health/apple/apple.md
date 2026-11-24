# Apple Health

One source, `apple-health:<account>:cloud`: the Health store, read two ways. The phone's
bundles (`connect/ios-app/`, connector `health-ios-bundle`) state live samples, deletions and
recorder events, and State of Mind, medication doses and the medication list, which only the
phone states (`state-of-mind`, `dose`, `medication`; `connect/ios-app/ios-app.md`). Apple's
export (connector `health-export`, here) states history up to the moment it was made. The
same sample read either way is the same record, byte for byte.

## The export

A delivery holds `export.xml`, or Apple's `export.zip` with `apple_health_export/export.xml`
in it. The XML is streamed. The statement time is the delivery's `exported_at`.

| Element | Kind | Key | Time |
|---|---|---|---|
| `Record`, `Correlation`, `Audiogram`, `VisionPrescription` | `sample` | the sample fingerprint | the sample's span, whole seconds UTC (a prescription: its `dateIssued`) |
| `Workout` | `workout` | the sample fingerprint | the workout's span |
| `ActivitySummary` | `day-summary` | its day, `YYYYMMDD` | that calendar date |
| `Me` | `characteristic`, one per attribute | its identifier (`HKCharacteristicTypeIdentifierDateOfBirth`) | none |
| `ExportDate`, `ClinicalRecord` | none | | |

`ExportDate` states no data. A `ClinicalRecord` waits with the phone's clinical records. A workout's `WorkoutRoute` lands
nothing: a route has no record yet.

Each element is a part: any other element, or one that breaks a rule below ("refuses"), is
refused alone and the rest lands. Character data, CDATA or an unknown entity refuses the export
file, after the elements before it; a delivery that holds no export, or two (a file named `.zip`
that is no zip holds none), is refused whole. The
export states no deletion: nothing it lacks is ever gone.

## A sample

`{type: health.sample, sample_type, start, end, value, unit, source_name, source_version,
device?, metadata, detail?}`. Every type lands: no list of types is read and the rest refused.

- **Key:** SHA-256 over the seven identity strings (type, start, end, value, unit, source
  name, source version), each NFC-normalised with `\` and `|` escaped, framed as
  `<UTF-8 bytes>:<text>` and joined by `|`; the first 12 hex digits.
- **Start, end:** whole-second UTC, floored. A bare date refuses.
- **Unit:** one per quantity type (`keyedUnit`): its rule's in `QUANTITY_UNITS` (the units the
  types read first were keyed in, kept byte for byte: `mi`, `lb`, `ft`, `count/min`), else the
  unit HealthKit documents for the type (`NATIVE_UNITS`, from `HKTypeIdentifiers.h`; a `%` type
  in `percent`). Every spelling of the same measure converts into it (`units.ts`: grams, metres,
  seconds and kelvins, prefixes, `·` and `/`, a temperature with its offset, a mole by its molar
  mass), so the export's `10 mi/hr` and the phone's `4.4704 m/s` are one key, and so are `98.6
  degF` and `37 degC`. The export's `%` is a fraction (×100, `percent`); a `count/s` read as
  `count/min` is snapped to an integer within a thousandth. A unit that does not convert (a type
  HealthKit does not document, a spelling that measures otherwise) keeps its unit as stated, but
  for `Cal` (kcal), a fractional `%` and `count/s`.
- **Value:** shortest decimal at six significant digits. A per-second integer
  (`1.31667 count/s`) is multiplied back and snapped; one that does not snap refuses.
- **Category:** the value's name (`HKCategoryValueSleepAnalysisAsleepCore`), from each type's
  enumeration in HealthKit's `HKTypeIdentifiers.h` as the export spells it (`CATEGORIES`); an
  integer outside it is stated as its integer, which the export's name keys apart from. A name an
  earlier SDK spelled otherwise, each deprecated alias of `HKCategoryValues.h`, is its name today
  (`ALIASES`): an older export's `HKCategoryValueSleepAnalysisAsleep` is
  `HKCategoryValueSleepAnalysisAsleepUnspecified`, the phone's 1; `…OvulationTestResultPositive` is
  `…LuteinizingHormoneSurge`; `…AudioExposureEventLoudEnvironment` is
  `…EnvironmentalAudioExposureEventMomentaryLimit`.
- **No value:** a type that states neither a quantity nor a category (an electrocardiogram, a
  heartbeat series, an audiogram, a correlation) has an empty value and unit.
- **Detail:** what the type states beside its identity, time, source, device and metadata, as
  the reader states it: a correlation's member records (`objects`, each as its own `Record`
  reads), an audiogram's `sensitivity_points`, a prescription's other attributes and `parts`
  (its eyes and attachments). The phone states an ECG's voltages and a heartbeat series' beats
  as blobs its detail names ([ios-app](../../ios-app/ios-app.md)). Content beside the identity may differ
  between the two readers; the key does not.
- **Device:** `hardware_model` and `software_version` only.
- **Metadata:** the bundle's types, through a key table; the export's strings are coerced
  (`"1"` → true). A key outside the table is kept as stated (the export's string, the bundle's
  value).

## A characteristic

`{type: health.characteristic, identifier, value}`, with no time, keyed by its identifier: one
record per attribute of `Me` named `HKCharacteristicTypeIdentifier…`, its value as `Me` spells it
(`1990-05-12`, `HKBiologicalSexFemale`, `HKBloodTypeOPositive`), null where Health holds none (an
empty date, a `…NotSet`). The phone's record of the same fact is the same bytes
(`connect/health/apple/characteristics.ts`). A fact a later export lacks is never gone.

## A workout

A `workout` record, keyed by the sample fingerprint: its type `HKWorkoutTypeIdentifier`, its
value the activity type as the export names it (`HKWorkoutActivityTypeRunning`; the bundle's
integer named through HealthKit's enumeration, an integer outside it stated as its integer),
unit empty. The export and the phone stating one workout land one record. Content:
`{type: health.workout, ...the seven identity strings, device?, metadata, detail}`; `detail`
is one shape from either reader, so the export and the phone stating one workout land the same
content byte for byte and a second landing writes no version: `duration_s` (seconds, a decimal,
or null), `distance` (`<decimal> m`, or null) and `energy` (active energy, `<decimal> kcal`, or
null), each from the workout's statistics where it states any of that measure (the distance
types' sums added), else from its stated total (the export's `totalDistance` and
`totalEnergyBurned`, the phone's `total_distance` and `total_energy`); `statistics`, each
`WorkoutStatistics` (the phone's `workout_statistics`) as `{type, start, end, sum, average,
minimum, maximum, unit}`, each figure in the unit its type is keyed in, sorted by type; `events`
(each `type` by the export's name, `start`, `duration_s`, `metadata`) and `stated`, what else
the reader's statement holds (the export's `WorkoutActivity` children, a total that does not
read). WHOOP writes its strain into the metadata
(`WHOOP Strain`). The export states no deletion; the phone's deletion of a workout states it
gone.

`day-summary` content: `{type: health.day-summary, date, active_energy_burned,
active_energy_burned_goal, active_energy_unit: kcal, move_time, move_time_goal,
exercise_time, exercise_time_goal, stand_hours, stand_hours_goal}`, every figure a decimal
string.

## What the health family reads

**Adapter** `appleHealthHealth` (adapter.ts; [health](../../../families/health/)). Health
holds many instruments' data, so every item names its instrument, the record's `source_name`.

| Kind | Read |
|---|---|
| `sample` | a quantity sample: `sample_type` as the metric, `value`, `unit`, the record's time. A sleep stage (`HKCategoryTypeIdentifierSleepAnalysis`) is a `stage`: its value in words (`in bed`, `asleep`, `core`, `deep`, `REM`, `awake`) and `metadata["WHOOP Recovery"]` |
| `workout` | an `instrument-workout`: `value` (the activity type, in words), `detail.duration_s`, `detail.distance`, `detail.energy`, the `average` and `maximum` of the `HKQuantityTypeIdentifierHeartRate` statistic in `count/min`, `metadata["WHOOP Strain"]` |
| `day-summary` | the date and the move, exercise and stand figures with their goals |

Nothing else is read: `created_at`, HealthKit `metadata` but those two, a sample's `detail` but a
workout's duration, distance, energy and heart rate, and `device` tick between exports without writing a row. A
tracker's copy written in under the name it declares (the WHOOP app writes `WHOOP`) is weighed
against the tracker's own data by the family.
