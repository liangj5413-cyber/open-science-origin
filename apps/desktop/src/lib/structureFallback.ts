import { isVaspStructureFile, parseVaspStructure } from "./vaspStructure";

export interface SimpleStructureAtom {
  element: string;
  x: number;
  y: number;
  z: number;
}

export interface SimpleStructure {
  format: string;
  title: string;
  atoms: SimpleStructureAtom[];
}

const ELEMENT_SYMBOLS = new Set([
  "H",
  "B",
  "C",
  "N",
  "O",
  "F",
  "Na",
  "Mg",
  "Al",
  "Si",
  "P",
  "S",
  "Cl",
  "K",
  "Ca",
  "Ti",
  "V",
  "Cr",
  "Mn",
  "Fe",
  "Co",
  "Ni",
  "Cu",
  "Zn",
  "Br",
  "I",
]);

export function parseStructureForFallback(filename: string, text: string): SimpleStructure | null {
  try {
    if (isVaspStructureFile(filename)) return parseVaspFallback(filename, text);
    const ext = extOf(filename);
    if (ext === "pdb" || ext === "pqr") return parsePdbFallback(filename, text);
    if (ext === "xyz") return parseXyzFallback(filename, text);
    if (ext === "mol2") return parseMol2Fallback(filename, text);
  } catch {
    return null;
  }
  return null;
}

export function structureFormula(structure: SimpleStructure): string {
  const counts = new Map<string, number>();
  for (const atom of structure.atoms) counts.set(atom.element, (counts.get(atom.element) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([element, count]) => `${element}${count === 1 ? "" : count}`)
    .join("");
}

function parseVaspFallback(filename: string, text: string): SimpleStructure | null {
  const structure = parseVaspStructure(text);
  if (structure.atoms.length === 0) return null;
  return {
    format: "VASP",
    title: structure.comment || filename,
    atoms: structure.atoms.map((atom) => ({
      element: atom.element,
      x: atom.cartesian[0],
      y: atom.cartesian[1],
      z: atom.cartesian[2],
    })),
  };
}

function parsePdbFallback(filename: string, text: string): SimpleStructure | null {
  const atoms: SimpleStructureAtom[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("ATOM") && !line.startsWith("HETATM")) continue;
    const coords = parsePdbCoords(line);
    if (!coords) continue;
    atoms.push({
      element: elementFromPdbLine(line),
      x: coords[0],
      y: coords[1],
      z: coords[2],
    });
  }
  return atoms.length > 0 ? { format: "PDB", title: filename, atoms } : null;
}

function parseXyzFallback(filename: string, text: string): SimpleStructure | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const declared = Number(lines[0]);
  const start = Number.isInteger(declared) && declared >= 0 ? 2 : 0;
  const atoms: SimpleStructureAtom[] = [];
  for (const line of lines.slice(start)) {
    const [elementToken, xToken, yToken, zToken] = line.split(/\s+/);
    const coords = [Number(xToken), Number(yToken), Number(zToken)];
    if (!elementToken || coords.some((value) => !Number.isFinite(value))) continue;
    atoms.push({
      element: normalizeElement(elementToken) ?? "X",
      x: coords[0],
      y: coords[1],
      z: coords[2],
    });
  }
  return atoms.length > 0 ? { format: "XYZ", title: filename, atoms } : null;
}

function parseMol2Fallback(filename: string, text: string): SimpleStructure | null {
  const atoms: SimpleStructureAtom[] = [];
  let inAtoms = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.toUpperCase() === "@<TRIPOS>ATOM") {
      inAtoms = true;
      continue;
    }
    if (inAtoms && trimmed.startsWith("@<TRIPOS>")) break;
    if (!inAtoms || !trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const x = Number(parts[2]);
    const y = Number(parts[3]);
    const z = Number(parts[4]);
    if (![x, y, z].every(Number.isFinite)) continue;
    const typeElement = parts[5]?.split(".")[0];
    atoms.push({
      element: normalizeElement(typeElement) ?? inferElementFromAtomName(parts[1]) ?? "X",
      x,
      y,
      z,
    });
  }
  return atoms.length > 0 ? { format: "MOL2", title: filename, atoms } : null;
}

function parsePdbCoords(line: string): [number, number, number] | null {
  const fixed = [parseNumberColumn(line.slice(30, 38)), parseNumberColumn(line.slice(38, 46)), parseNumberColumn(line.slice(46, 54))];
  if (fixed.every(Number.isFinite)) return [fixed[0], fixed[1], fixed[2]];

  const parts = line.trim().split(/\s+/);
  for (let i = 4; i <= parts.length - 3; i += 1) {
    const coords = [Number(parts[i]), Number(parts[i + 1]), Number(parts[i + 2])];
    if (coords.every(Number.isFinite)) return [coords[0], coords[1], coords[2]];
  }
  return null;
}

function parseNumberColumn(value: string): number {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : Number.NaN;
}

function elementFromPdbLine(line: string): string {
  return normalizeElement(line.slice(76, 78).trim()) ?? inferElementFromAtomName(line.slice(12, 16).trim()) ?? "X";
}

function inferElementFromAtomName(name: string | undefined): string | null {
  if (!name) return null;
  const clean = name.replace(/[^A-Za-z]/g, "");
  if (!clean) return null;
  const firstTwo = normalizeElement(clean.slice(0, 2));
  if (firstTwo) return firstTwo;
  return normalizeElement(clean.slice(0, 1));
}

function normalizeElement(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.slice(0, 1).toUpperCase() + trimmed.slice(1, 2).toLowerCase();
  return ELEMENT_SYMBOLS.has(normalized) ? normalized : null;
}

function extOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}
