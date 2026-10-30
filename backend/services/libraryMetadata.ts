import * as v from "valibot";
import { dbHelpers } from "../config/db-sqlite.ts";
import { lenient, listOf } from "../db/helpers/storedSchemas.ts";

const nullableText = lenient(v.nullable(v.string()));

const libraryImageSchema = v.looseObject({
  remoteUrl: nullableText,
  imageUrl: nullableText,
  url: nullableText,
  Url: nullableText,
  coverType: nullableText,
  kind: nullableText,
  CoverType: nullableText,
});

export type LibraryArtistImage = v.InferOutput<typeof libraryImageSchema>;

const libraryMetadataSchema = v.looseObject({
  id: lenient(v.nullable(v.union([v.string(), v.number()]))),
  artistId: lenient(v.nullable(v.union([v.string(), v.number()]))),
  monitored: lenient(v.nullable(v.boolean())),
  monitor: nullableText,
  monitorOption: nullableText,
  addOptions: lenient(v.nullable(v.looseObject({ monitor: nullableText }))),
  foreignArtistId: nullableText,
  foreignAlbumId: nullableText,
  foreignRecordingId: nullableText,
  foreignTrackId: nullableText,
  librarySource: nullableText,
  images: lenient(v.nullable(listOf(libraryImageSchema))),
  path: nullableText,
  added: nullableText,
  monitorNewItems: nullableText,
  qualityProfile: lenient(v.nullable(v.looseObject({ name: nullableText }))),
  albumType: nullableText,
  releaseType: nullableText,
  edition: lenient(v.string()),
  requestedRelease: nullableText,
  trackList: lenient(v.nullable(v.looseObject({ release: nullableText }))),
  trackListComplete: lenient(v.boolean()),
  artistAliases: lenient(listOf(v.string())),
  durationMs: lenient(v.nullable(v.number())),
});

export type LibraryMetadata = v.InferOutput<typeof libraryMetadataSchema>;

export const readLibraryMetadata = (text: string | null | undefined) =>
  dbHelpers.readJSON(libraryMetadataSchema, text, "library metadata");

export const readRawLibraryMetadata = (text: string | null | undefined) =>
  dbHelpers.readJSON(v.record(v.string(), v.unknown()), text, "library metadata") ?? {};
