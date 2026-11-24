# Geography data

The three files `areaOf` and `zoneOf` (`families/shared/geography.ts`) read to give any point its
city, region, country and time zone. They ship in the
release with the rest of the package, and nothing fetches them: every home gives the same area for
the same point.

| File | Holds | Size |
|---|---|---|
| `world.json` | each country: its name, ISO 3166-1 alpha-2 code (or null), polygons, and its regions with theirs | 6.4 MB |
| `cities.tsv` | each place of 15,000 people or more: name, latitude, longitude, population, GeoNames feature code, country code | 1.4 MB |
| `zones.tsv` | each place's IANA time zone as GeoNames states it (`cities15000.txt`'s column 18), run-length coded: `<rows>\t<zone>`, the next rows of `cities.tsv` in that zone | 67 KB |

## Where each comes from

- **Natural Earth 1:10m Cultural Vectors, version 5.1.1:** Admin 0 – Countries
  (`ne_10m_admin_0_countries`) and Admin 1 – States, Provinces (`ne_10m_admin_1_states_provinces`),
  from naturalearthdata.com. Simplified with mapshaper 0.6.102, which the repository does not
  depend on (run it with `npx`), by Douglas–Peucker to 20% of the points:

  ```sh
  mapshaper -i ne_10m_admin_0_countries.shp -simplify dp 20% keep-shapes \
    -filter-fields ADM0_A3,ISO_A2_EH,NAME_LONG -o admin0.json format=geojson precision=0.0001
  mapshaper -i ne_10m_admin_1_states_provinces.shp -simplify dp 20% keep-shapes \
    -filter-fields adm0_a3,name -o admin1.json format=geojson precision=0.0001
  ```

- **GeoNames:** `cities15000.txt` (the places of 15,000 people or more), `countryInfo.txt` (each
  ISO code's English name) and `admin1CodesASCII.txt` (each country's first-level divisions), from
  download.geonames.org/export/dump/, downloaded on 14 November 2026.

`npx tsx tools/geography.ts <folder>`, with the five files in the folder, writes the three files here
and prints two digests. `GEOGRAPHY_VERSION` is the rule's number, a dash, and the digest of
`world.json` and `cities.tsv`; `ZONES_VERSION` likewise of `zones.tsv`, kept apart because a zone
says no area, so new zones render no day again. Set them in the same change (the test holds them to
the files), and bump the rule's number when the rule changes.

## How they were made

- **Polygons:** coordinates at 4 decimals (about 11 m); each ring without GeoJSON's closing repeat.
- **One country per ISO code:** Natural Earth's units of one code are merged (Baikonur into
  Kazakhstan, Clipperton into France). A country is named by GeoNames' English name for its code
  ("South Korea", not "Republic of Korea"); a unit Natural Earth gives no code (Northern Cyprus,
  Somaliland, Siachen Glacier) keeps its own long name and no code.
- **Regions are GeoNames' first-level divisions.** Natural Earth's admin-1 is not one level
  everywhere: the United Kingdom's are its local authorities, France's its départements. Each
  admin-1 polygon takes the division most of its country's places inside it carry (3,378 of the
  4,596 polygons); else most of any places inside it (13, such as Réunion's, inside France); else
  the division of the country's nearest place within 50 km (960); else Natural Earth's own name
  (245, mostly islands far from any place: Orkney, Shetland, the Maldives' atolls). Polygons of one
  division merge into one region, 2,856 in all. So the United Kingdom has England, Scotland, Wales
  and Northern Ireland, and Orkney, Shetland and the Isles of Scilly; France its 13 régions
  (Île-de-France, Grand Est); the United States its 50 states and the District of Columbia; India
  its states and union territories; China its provinces, autonomous regions and municipalities;
  Brazil its 26 states and the Federal District. The names are GeoNames' ("Moscow", not "Moskva").
- **Countries with no polygons:** a code places carry and no polygon does (Mayotte, Svalbard, the
  Cocos Islands) is a country with no polygons, for an island the simplification dropped.
- **Places:** six of the nineteen columns, every row kept. Which places count (not historical,
  abandoned or destroyed; a section of a city only with a million people) is the module's rule, not
  the file's.

## Why Douglas–Peucker at 20%

Measured over all 34,215 places of 15,000 people or more (GeoNames of 14 November 2026), each asked
at its own point: how many `areaOf` puts in another country than GeoNames' code, and, of those in
the right country, how many in another region than GeoNames' division. "Weighted" is mapshaper's
default, Visvalingam weighted; "DP" is Douglas–Peucker. Bundled is the three files together.

| Simplified to | `world.json` | Bundled in all | Country differs | Region differs |
|---|---|---|---|---|
| weighted 4% | 1.8 MB | 3.3 MB | 206 (0.60%) | 1,168 of 34,009 (3.4%) |
| weighted 10% (to 14 November) | 3.7 MB | 5.2 MB | 169 (0.49%) | 875 of 34,046 (2.6%) |
| DP 10% | 3.5 MB | 5.0 MB | 181 (0.53%) | 846 of 34,034 (2.5%) |
| weighted 20% | 6.7 MB | 8.2 MB | 159 (0.46%) | 803 of 34,056 (2.4%) |
| **DP 20%** | **6.4 MB** | **7.9 MB** | **159 (0.46%)** | **789 of 34,056 (2.3%)** |
| weighted 25% | 8.2 MB | 9.7 MB | 155 (0.45%) | 787 of 34,060 (2.3%) |
| not simplified | 30 MB | 31.6 MB | 158 (0.46%) | 747 of 34,057 (2.2%) |

Of the settings measured, it is the smallest that tells each side of a dense river border as its
own state: Manhattan is New York and the Hudson's west shore New Jersey; Vancouver, Washington is
Washington, not Oregon; Camden's centre, which lies outside every polygon, nearest New Jersey's
edge. Weighted
20% leaves Midtown outside New York's polygon and nearer New Jersey's edge, and puts Camden nearer
Pennsylvania's; weighted 25% is right too, for 1.8 MB more. Its country misses equal the
unsimplified floor's count; the floor itself is where the two sources disagree, not the
simplification. The bundle's bound is 8.5 MB, held by the geography test.

## What it gets wrong

- **The floor: the two sources disagree.** Of the 6,290 places of 100,000 or more, 19 are in
  another country than GeoNames says: disputes Natural Earth rules otherwise (Crimea in Russia,
  Western Sahara in Morocco, Jerusalem and Gaza), codes it does not split (Réunion in France), and
  centres within a few km of a border. A region named by majority can differ from a place's own
  division near the region's edge, and a division is not always the level people say (Buenos
  Aires' suburbs are "Buenos Aires", the city itself "Buenos Aires F.D.").
- **Natural Earth's own border, at any setting:** the 1:10m Missouri–Illinois line puts St.
  Louis's centre in Illinois, unsimplified too, so St. Louis is a city of Illinois: East St. Louis
  is told as St. Louis, Illinois, and the Missouri side of St. Louis as Illinois.
- **Still wrong at 20%, right unsimplified:** El Paso's centre falls inside Mexico's polygon, so it
  is told as Ciudad Juárez, Mexico: the city follows the country.
- **Wrong at 10%, right at 20%:** New York City's centre (lower Manhattan) and Midtown lay outside
  both layers' polygons with New Jersey's edge the nearest, so Manhattan was New Jersey and New
  Jersey's points near it New York City, New Jersey; now Manhattan is New York City, New York, and
  Hoboken and Jersey City are Newark, New Jersey (the metro rule's most populous place of 100,000
  within 25 km). Vancouver, Washington was Portland, Oregon. Macau's centre lay outside its own
  small polygon, so it was Zhongshan, China. Key West and Tarawa were islands with no polygon.
- **Right at 10%, wrong at 4%:** Geneva (France at 4%), Yerevan (Kotayk), Addis Ababa (Oromiya),
  Cairo (Giza).
- **An island with no place within 30 km** has no country: no polygon is near and no place names
  it.

## Licences

- Natural Earth is in the public domain.
- GeoNames is licensed under CC BY 4.0: the places, divisions and country names are © GeoNames
  (geonames.org), used under https://creativecommons.org/licenses/by/4.0/.
