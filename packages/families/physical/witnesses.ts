import type { BlobReader, View, Witness as WitnessAdapter } from "@lifestreamprotocol/core";
import type { Change, FamilyInput, Given, Touched } from "../family.js";
import type { Evidence, How, Said } from "./evidence.js";
import { phoneWitness } from "./phone.js";
import type { PhotoRoutes } from "../photos/read.js";
import { photoWitness } from "./seen.js";
import { statedWitness } from "./stated.js";

export interface Part<T = unknown> {
  owns(unit: string): boolean;
  inputs: FamilyInput[];
  touched(changes: readonly Change[], view: View): Touched[];
  extract(unit: string, view: View, files: BlobReader): T | null;
}

export interface Witness extends Part<Said<Evidence>> {
  name: string;
  rank: number;
  how: How;
}

export function witnesses(photos: PhotoRoutes, given: readonly Given<WitnessAdapter>[]): readonly Witness[] {
  const motion = given.filter((each) => each.adapter.motion !== undefined);
  const table = [
    photoWitness(photos),
    ...given.flatMap((each) => (each.adapter.fix !== undefined ? [phoneWitness(each, motion)]
      : each.adapter.visit !== undefined || each.adapter.activity !== undefined ? [statedWitness(each)] : [])),
  ];
  return table.sort((left, right) => left.rank - right.rank);
}

export function declared(given: Given<WitnessAdapter>): Pick<Witness, "name" | "rank" | "how"> {
  const { name, rank, how } = given.adapter;
  if (name === undefined || rank === undefined || how === undefined) throw new TypeError(`${given.product}'s physical adapter states evidence and declares no witness (name, rank, how)`);
  return { name, rank, how };
}
