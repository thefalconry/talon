#!/usr/bin/env node
/**
 * Windows PE hardening check for the shipped .exe files (companion and
 * talon-node). Reads each image's optional-header DllCharacteristics and
 * fails CI when ASLR (DYNAMICBASE) or DEP (NXCOMPAT) is missing.
 *
 * Control Flow Guard (GUARD_CF) is reported as a warning only: Go's linker
 * never emits it, and the Flutter runner is not built with /guard:cf. Pass
 * --require-cfg to make it fatal once a binary is expected to carry it.
 *
 * Dependency-free and cross-platform on purpose: talon-node.exe is
 * cross-compiled on Linux, where dumpbin does not exist.
 *
 *   node scripts/check-pe-hardening.mjs [--require-cfg] <file.exe>...
 */

import { readFileSync } from "node:fs";

const FLAGS = [
  { name: "HIGH_ENTROPY_VA", bit: 0x0020, level: "info" },
  { name: "DYNAMICBASE", bit: 0x0040, level: "error" },
  { name: "NXCOMPAT", bit: 0x0100, level: "error" },
  { name: "GUARD_CF", bit: 0x4000, level: "warning" },
];

/** Returns the DllCharacteristics word of a PE image, or throws. */
function dllCharacteristics(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) {
    throw new Error("not a PE image (no MZ header)");
  }
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 + 72 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) {
    throw new Error("not a PE image (no PE signature)");
  }
  const opt = pe + 24; // "PE\0\0" + 20-byte COFF header
  const magic = buf.readUInt16LE(opt);
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new Error(`unknown optional-header magic 0x${magic.toString(16)}`);
  }
  // DllCharacteristics sits at offset 70 in both PE32 and PE32+.
  return buf.readUInt16LE(opt + 70);
}

/** Checks one file; returns the number of fatal findings. */
function checkFile(path, requireCfg) {
  let chars;
  try {
    chars = dllCharacteristics(readFileSync(path));
  } catch (err) {
    console.log(`::error file=${path}::${err.message}`);
    return 1;
  }
  let fatal = 0;
  const hex = `0x${chars.toString(16).padStart(4, "0")}`;
  console.log(`${path}: DllCharacteristics ${hex}`);
  for (const { name, bit, level } of FLAGS) {
    const set = (chars & bit) !== 0;
    console.log(`  ${set ? "yes" : "NO "} ${name}`);
    if (set) continue;
    const effective = name === "GUARD_CF" && requireCfg ? "error" : level;
    if (effective === "error") {
      console.log(`::error file=${path}::${name} is not set`);
      fatal++;
    } else if (effective === "warning") {
      console.log(`::warning file=${path}::${name} is not set (not enforced)`);
    }
  }
  return fatal;
}

function main(argv) {
  const requireCfg = argv.includes("--require-cfg");
  const files = argv.filter((a) => !a.startsWith("--"));
  if (files.length === 0) {
    console.log("::error::check-pe-hardening: no files given");
    return 1;
  }
  let fatal = 0;
  for (const file of files) fatal += checkFile(file, requireCfg);
  return fatal === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
