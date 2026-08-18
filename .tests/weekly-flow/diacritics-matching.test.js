import test from "node:test";
import assert from "node:assert/strict";
import {
  artistNamesMatch,
  foldDiacritics,
  getNormalizedText,
  normalizeTitle,
  scoreTextMatch,
} from "../../backend/services/providers/brainzmashRanking.js";

const matcher = { extended: true };

test("foldDiacritics maps accented and special letters to their base form", () => {
  assert.equal(foldDiacritics("Canción"), "Cancion");
  assert.equal(foldDiacritics("Aunque tú no lo sepas"), "Aunque tu no lo sepas");
  assert.equal(foldDiacritics("Björk"), "Bjork");
  assert.equal(foldDiacritics("Sigur Rós"), "Sigur Ros");
  assert.equal(foldDiacritics("Motörhead"), "Motorhead");
  assert.equal(foldDiacritics("Café del Mar"), "Cafe del Mar");
  assert.equal(foldDiacritics("Blue Öyster Cult"), "Blue Oyster Cult");
  assert.equal(foldDiacritics("Mötley Crüe"), "Motley Crue");
  assert.equal(foldDiacritics("Nothing to fold"), "Nothing to fold");
});

test("foldDiacritics folds sharp s in both cases", () => {
  // The fold runs before lowercasing, so the capital form needs its own mapping.
  assert.equal(foldDiacritics("Straße"), "Strasse");
  assert.equal(foldDiacritics("STRAẞE"), "STRASSE");
  assert.equal(getNormalizedText("STRAẞE"), "strasse");
  assert.equal(artistNamesMatch("STRASSE", "STRAẞE"), true);
});

test("foldDiacritics handles letters that carry no combining mark", () => {
  assert.equal(foldDiacritics("Sinéad Ó'Connor"), "Sinead O'Connor");
  assert.equal(foldDiacritics("Anastacia — Größe"), "Anastacia — Grosse");
  assert.equal(foldDiacritics("Æther"), "AEther");
  assert.equal(foldDiacritics("Håkan Hellström"), "Hakan Hellstrom");
});

test("foldDiacritics only folds Latin script, leaving other writing systems intact", () => {
  // Japanese dakuten and the Cyrillic breve are combining marks too: folding them
  // would merge distinct characters (ka/ga, i/short-i) and collide unrelated titles.
  assert.equal(foldDiacritics("がき"), "がき");
  assert.notEqual(foldDiacritics("がき"), foldDiacritics("かき"));
  assert.equal(foldDiacritics("ばら"), "ばら");
  assert.notEqual(foldDiacritics("ぱん"), foldDiacritics("はん"));
  assert.equal(foldDiacritics("Мумий Тролль"), "Мумий Тролль");
  assert.notEqual(foldDiacritics("мой"), foldDiacritics("мои"));
});

test("scoreTextMatch keeps non-Latin near-homographs apart", () => {
  assert.notEqual(scoreTextMatch("がき", "かき", matcher), 100);
  assert.notEqual(scoreTextMatch("мой", "мои", matcher), 100);
});

test("normalizeTitle ignores diacritics so accented shares still match", () => {
  assert.equal(
    normalizeTitle("Aunque tú no lo sepas", matcher),
    normalizeTitle("Aunque Tu No Lo Sepas", matcher),
  );
  assert.equal(normalizeTitle("Déjà Vu", matcher), normalizeTitle("Deja Vu", matcher));
});

test("scoreTextMatch treats an accent difference as an exact match", () => {
  assert.equal(scoreTextMatch("Cancion", "Canción", matcher), 100);
  assert.equal(scoreTextMatch("Aunque Tu No Lo Sepas", "Aunque tú no lo sepas", matcher), 100);
  assert.equal(scoreTextMatch("Un Canto a Galicia", "Un canto a Galícia", matcher), 100);
});

test("getNormalizedText keeps accented words whole instead of splitting them", () => {
  assert.equal(getNormalizedText("Canción"), "cancion");
  assert.equal(getNormalizedText("Rocío Jurado"), "rocio jurado");
  assert.equal(getNormalizedText("Björk"), "bjork");
});

test("artistNamesMatch ignores diacritics", () => {
  assert.equal(artistNamesMatch("Rocio Jurado", "Rocío Jurado"), true);
  assert.equal(artistNamesMatch("Sigur Ros", "Sigur Rós"), true);
  assert.equal(artistNamesMatch("Rocio Jurado", "Rocio Durcal"), false);
});

test("scoreTextMatch still separates genuinely different titles", () => {
  assert.ok(scoreTextMatch("Aunque Tu No Lo Sepas", "Zapatillas", matcher) < 50);
  assert.equal(scoreTextMatch("", "Canción", matcher), 0);
});
