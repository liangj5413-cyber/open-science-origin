type Vec3 = [number, number, number];

export type VaspCoordinateMode = "direct" | "cartesian";

export interface VaspStructureAtom {
  element: string;
  fractional: Vec3;
  cartesian: Vec3;
}

export interface VaspStructure {
  comment: string;
  lattice: [Vec3, Vec3, Vec3];
  pbc: [true, true, true];
  species: string[];
  counts: number[];
  coordinateMode: VaspCoordinateMode;
  selectiveDynamics: boolean;
  atoms: VaspStructureAtom[];
  warnings: string[];
}

export interface StructureJsonAtom {
  element: string;
  x: number;
  y: number;
  z: number;
  coords_are_cartesian: boolean;
}

export interface StructureJson {
  lattice: [Vec3, Vec3, Vec3];
  pbc: [true, true, true];
  atoms: StructureJsonAtom[];
  bonds: [];
  frames: null;
  properties: Record<string, unknown>;
}

const PERIODIC_SYMBOLS = new Set([
  "H",
  "He",
  "Li",
  "Be",
  "B",
  "C",
  "N",
  "O",
  "F",
  "Ne",
  "Na",
  "Mg",
  "Al",
  "Si",
  "P",
  "S",
  "Cl",
  "Ar",
  "K",
  "Ca",
  "Sc",
  "Ti",
  "V",
  "Cr",
  "Mn",
  "Fe",
  "Co",
  "Ni",
  "Cu",
  "Zn",
  "Ga",
  "Ge",
  "As",
  "Se",
  "Br",
  "Kr",
  "Rb",
  "Sr",
  "Y",
  "Zr",
  "Nb",
  "Mo",
  "Tc",
  "Ru",
  "Rh",
  "Pd",
  "Ag",
  "Cd",
  "In",
  "Sn",
  "Sb",
  "Te",
  "I",
  "Xe",
  "Cs",
  "Ba",
  "La",
  "Ce",
  "Pr",
  "Nd",
  "Pm",
  "Sm",
  "Eu",
  "Gd",
  "Tb",
  "Dy",
  "Ho",
  "Er",
  "Tm",
  "Yb",
  "Lu",
  "Hf",
  "Ta",
  "W",
  "Re",
  "Os",
  "Ir",
  "Pt",
  "Au",
  "Hg",
  "Tl",
  "Pb",
  "Bi",
  "Po",
  "At",
  "Rn",
  "Fr",
  "Ra",
  "Ac",
  "Th",
  "Pa",
  "U",
  "Np",
  "Pu",
  "Am",
  "Cm",
  "Bk",
  "Cf",
  "Es",
  "Fm",
  "Md",
  "No",
  "Lr",
  "Rf",
  "Db",
  "Sg",
  "Bh",
  "Hs",
  "Mt",
  "Ds",
  "Rg",
  "Cn",
  "Nh",
  "Fl",
  "Mc",
  "Lv",
  "Ts",
  "Og",
]);

function baseNameOf(filename: string): string {
  return filename.split(/[\\/]/).pop() ?? filename;
}

function extOf(filename: string): string {
  const base = baseNameOf(filename);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function isVaspStructureFile(filename: string): boolean {
  const base = baseNameOf(filename).toLowerCase();
  const ext = extOf(filename);
  return (
    ext === "poscar" ||
    ext === "contcar" ||
    ext === "vasp" ||
    /^(poscar|contcar)(?:$|[._-])/.test(base)
  );
}

export function parseVaspStructure(text: string): VaspStructure {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines.length < 8) throw new Error("POSCAR is incomplete; expected at least 8 lines.");

  const comment = lines[0].trim() || "POSCAR";
  const rawScale = parseSingleNumber(lines[1], "scale factor");
  if (rawScale === 0) throw new Error("POSCAR scale factor must not be zero.");

  const rawLattice: [Vec3, Vec3, Vec3] = [
    parseVec3(lines[2], "lattice vector a"),
    parseVec3(lines[3], "lattice vector b"),
    parseVec3(lines[4], "lattice vector c"),
  ];
  const scale = rawScale > 0 ? rawScale : scaleFromTargetVolume(rawLattice, Math.abs(rawScale));
  const lattice = rawLattice.map((v) => scaleVec(v, scale)) as [Vec3, Vec3, Vec3];

  const warnings: string[] = [];
  let cursor = 5;
  let species: string[];
  let counts: number[];

  const line5 = tokens(lines[cursor]);
  const line6 = tokens(lines[cursor + 1]);
  if (line5.length > 0 && areElementSymbols(line5) && arePositiveIntegerTokens(line6)) {
    species = line5.map(normalizeElementSymbol);
    counts = line6.map((value) => Number(value));
    cursor += 2;
  } else if (arePositiveIntegerTokens(line5)) {
    counts = line5.map((value) => Number(value));
    species = inferSpeciesFromComment(comment, counts.length);
    cursor += 1;
    if (species.some((symbol) => symbol === "X")) {
      warnings.push("Element symbols were not declared; using X placeholders for unknown species.");
    }
  } else {
    throw new Error("POSCAR atom species/counts block is malformed.");
  }

  if (species.length !== counts.length) throw new Error("POSCAR species and atom count lengths do not match.");
  const totalAtoms = counts.reduce((sum, count) => sum + count, 0);
  if (totalAtoms <= 0) throw new Error("POSCAR declares no atoms.");

  let selectiveDynamics = false;
  let modeLine = lines[cursor]?.trim() ?? "";
  if (/^s/i.test(modeLine)) {
    selectiveDynamics = true;
    cursor += 1;
    modeLine = lines[cursor]?.trim() ?? "";
  }

  const coordinateMode = coordinateModeFromLine(modeLine);
  cursor += 1;
  if (lines.length - cursor < totalAtoms) {
    throw new Error(`POSCAR has ${lines.length - cursor} coordinate rows, but ${totalAtoms} atoms were declared.`);
  }

  const atoms: VaspStructureAtom[] = [];
  let speciesIndex = 0;
  let speciesRemaining = counts[0];
  for (let i = 0; i < totalAtoms; i += 1) {
    while (speciesRemaining === 0) {
      speciesIndex += 1;
      speciesRemaining = counts[speciesIndex];
    }
    const element = species[speciesIndex];
    const coords = parseVec3(lines[cursor + i], `coordinate row ${i + 1}`);
    const cartesian = coordinateMode === "cartesian" ? scaleVec(coords, scale) : directToCartesian(coords, lattice);
    const fractional = coordinateMode === "direct" ? coords : cartesianToFractional(cartesian, lattice);
    atoms.push({ element, fractional, cartesian });
    speciesRemaining -= 1;
  }

  return {
    comment,
    lattice,
    pbc: [true, true, true],
    species,
    counts,
    coordinateMode,
    selectiveDynamics,
    atoms,
    warnings,
  };
}

export function vaspStructureToStructureJson(structure: VaspStructure): StructureJson {
  const useCartesian = structure.coordinateMode === "cartesian";
  return {
    lattice: structure.lattice,
    pbc: [true, true, true],
    atoms: structure.atoms.map((atom) => {
      const coords = useCartesian ? atom.cartesian : atom.fractional;
      return {
        element: atom.element,
        x: coords[0],
        y: coords[1],
        z: coords[2],
        coords_are_cartesian: useCartesian,
      };
    }),
    bonds: [],
    frames: null,
    properties: {
      comment: structure.comment,
      format: "poscar",
      coordinateMode: structure.coordinateMode,
      selectiveDynamics: structure.selectiveDynamics,
      formula: formulaFor(structure),
      warnings: structure.warnings,
    },
  };
}

export function vaspStructureToVasp5(structure: VaspStructure): string {
  const mode = structure.coordinateMode === "cartesian" ? "Cartesian" : "Direct";
  const coordinateRows = structure.atoms.map((atom) => {
    const coords = structure.coordinateMode === "cartesian" ? atom.cartesian : atom.fractional;
    return coords.map(formatNumber).join(" ");
  });

  return [
    structure.comment || "POSCAR",
    "1.0",
    ...structure.lattice.map((v) => v.map(formatNumber).join(" ")),
    structure.species.join(" "),
    structure.counts.join(" "),
    mode,
    ...coordinateRows,
    "",
  ].join("\n");
}

export function summarizeVaspStructure(structure: VaspStructure): string {
  const [a, b, c] = structure.lattice.map(vectorLength);
  const mode = structure.coordinateMode === "cartesian" ? "Cartesian" : "Direct";
  return `${formulaFor(structure)} | ${mode} | a=${formatShortNumber(a)} A b=${formatShortNumber(b)} A c=${formatShortNumber(c)} A`;
}

function parseSingleNumber(line: string | undefined, label: string): number {
  const values = tokens(line ?? "");
  if (values.length !== 1) throw new Error(`Invalid ${label}.`);
  const value = Number(values[0]);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function parseVec3(line: string | undefined, label: string): Vec3 {
  const values = tokens(line ?? "").slice(0, 3).map((value) => Number(value));
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`Invalid ${label}; expected three numeric values.`);
  }
  return [values[0], values[1], values[2]];
}

function tokens(line: string): string[] {
  const withoutComment = line.split("#", 1)[0];
  return withoutComment.trim().split(/\s+/).filter(Boolean);
}

function arePositiveIntegerTokens(values: string[]): boolean {
  return values.length > 0 && values.every((value) => /^\d+$/.test(value) && Number(value) > 0);
}

function areElementSymbols(values: string[]): boolean {
  return values.length > 0 && values.every((value) => PERIODIC_SYMBOLS.has(normalizeElementSymbol(value)));
}

function normalizeElementSymbol(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

function inferSpeciesFromComment(comment: string, count: number): string[] {
  const inferred: string[] = [];
  for (const token of comment.split(/[\s,;:_/\\()[\]{}+-]+/)) {
    for (const match of token.matchAll(/[A-Z][a-z]?/g)) {
      const symbol = normalizeElementSymbol(match[0]);
      if (PERIODIC_SYMBOLS.has(symbol) && !inferred.includes(symbol)) inferred.push(symbol);
    }
  }
  while (inferred.length < count) inferred.push("X");
  return inferred.slice(0, count);
}

function coordinateModeFromLine(line: string): VaspCoordinateMode {
  const first = line.trim().slice(0, 1).toLowerCase();
  if (first === "d") return "direct";
  if (first === "c" || first === "k") return "cartesian";
  throw new Error("POSCAR coordinate mode must be Direct or Cartesian.");
}

function directToCartesian(fractional: Vec3, lattice: [Vec3, Vec3, Vec3]): Vec3 {
  const [u, v, w] = fractional;
  const [a, b, c] = lattice;
  return [
    u * a[0] + v * b[0] + w * c[0],
    u * a[1] + v * b[1] + w * c[1],
    u * a[2] + v * b[2] + w * c[2],
  ];
}

function cartesianToFractional(cartesian: Vec3, lattice: [Vec3, Vec3, Vec3]): Vec3 {
  const [a, b, c] = lattice;
  const volume = dot(a, cross(b, c));
  if (Math.abs(volume) < 1e-12) throw new Error("POSCAR lattice vectors are degenerate.");
  return [
    dot(cartesian, cross(b, c)) / volume,
    dot(cartesian, cross(c, a)) / volume,
    dot(cartesian, cross(a, b)) / volume,
  ];
}

function scaleFromTargetVolume(lattice: [Vec3, Vec3, Vec3], targetVolume: number): number {
  const volume = Math.abs(dot(lattice[0], cross(lattice[1], lattice[2])));
  if (!Number.isFinite(targetVolume) || targetVolume <= 0) throw new Error("Invalid negative POSCAR volume scale.");
  if (volume < 1e-12) throw new Error("POSCAR lattice vectors are degenerate.");
  return Math.cbrt(targetVolume / volume);
}

function scaleVec(v: Vec3, scale: number): Vec3 {
  return [v[0] * scale, v[1] * scale, v[2] * scale];
}

function vectorLength(v: Vec3): number {
  return Math.sqrt(dot(v, v));
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function formulaFor(structure: VaspStructure): string {
  const counts = new Map<string, number>();
  structure.species.forEach((symbol, index) => {
    counts.set(symbol, (counts.get(symbol) ?? 0) + structure.counts[index]);
  });
  return Array.from(counts.entries())
    .map(([symbol, count]) => `${symbol}${count === 1 ? "" : count}`)
    .join("");
}

function formatNumber(value: number): string {
  if (Math.abs(value) < 1e-12) return "0";
  return value.toFixed(10).replace(/\.?0+$/, "");
}

function formatShortNumber(value: number): string {
  if (Math.abs(value) < 1e-12) return "0";
  return value.toFixed(3).replace(/\.?0+$/, "");
}
