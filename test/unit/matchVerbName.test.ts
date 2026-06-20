import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesVerbName } from "../../src/resolve/matchVerbName.js";

test("matches exact verb aliases case-insensitively", () => {
  assert.equal(matchesVerbName("trim", "trim"), true);
  assert.equal(matchesVerbName("Trim", "TRIM"), true);
  assert.equal(matchesVerbName("trim", "tri"), false);
  assert.equal(matchesVerbName("trim", "trimmed"), false);
});

test("matches ToastStunt embedded wildcard abbreviations", () => {
  assert.equal(matchesVerbName("l*ook", "l"), true);
  assert.equal(matchesVerbName("l*ook", "lo"), true);
  assert.equal(matchesVerbName("l*ook", "loo"), true);
  assert.equal(matchesVerbName("l*ook", "look"), true);
  assert.equal(matchesVerbName("l*ook", "ook"), false);
  assert.equal(matchesVerbName("l*ook", "looky"), false);
});

test("matches end wildcards as any suffix", () => {
  assert.equal(matchesVerbName("*", "anything"), true);
  assert.equal(matchesVerbName("?*", "?"), true);
  assert.equal(matchesVerbName("?*", "?foo"), true);
  assert.equal(matchesVerbName("?*", "help"), false);
});

test("matches command-style aliases", () => {
  assert.equal(matchesVerbName("@newmess*age", "@newmess"), true);
  assert.equal(matchesVerbName("@newmess*age", "@newmessa"), true);
  assert.equal(matchesVerbName("@newmess*age", "@newmessage"), true);
  assert.equal(matchesVerbName("@newmess*age", "@new"), false);
  assert.equal(matchesVerbName("@newmess*age", "newmessage"), false);
});

test("does not match past a non-terminal wildcard expansion", () => {
  assert.equal(matchesVerbName("room_announce*_all_but", "room_announce"), true);
  assert.equal(matchesVerbName("room_announce*_all_but", "room_announce_all_but"), true);
  assert.equal(matchesVerbName("room_announce*_all_but", "room_announce_all_but_extra"), false);
});

test("matches aliases in a space-separated verb name list", () => {
  assert.equal(matchesVerbName("look l*ook", "loo"), true);
  assert.equal(matchesVerbName("look l*ook", "inspect"), false);
});
