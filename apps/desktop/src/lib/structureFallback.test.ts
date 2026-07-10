import { describe, expect, it } from "vitest";
import { parseStructureForFallback, structureFormula } from "./structureFallback";

const PDB = [
  "ATOM      1  C1  LIG A   1       0.000   0.000   0.000  1.00  0.00           C",
  "HETATM    2  O1  LIG A   1       1.200   0.000   0.000  1.00  0.00           O",
  "ATOM      3  H1  LIG A   1      -0.600   0.800   0.000  1.00  0.00           H",
].join("\n");

describe("parseStructureForFallback", () => {
  it("parses PDB ATOM/HETATM coordinates for non-WebGL previews", () => {
    const structure = parseStructureForFallback("ligand.pdb", PDB);

    expect(structure?.format).toBe("PDB");
    expect(structure?.atoms).toHaveLength(3);
    expect(structure?.atoms[1]).toMatchObject({ element: "O", x: 1.2, y: 0, z: 0 });
    expect(structureFormula(structure!)).toBe("COH");
  });

  it("parses XYZ coordinates", () => {
    const structure = parseStructureForFallback("mol.xyz", "2\nwater\nO 0 0 0\nH 0.7 0.7 0\n");

    expect(structure?.format).toBe("XYZ");
    expect(structure?.atoms.map((atom) => atom.element)).toEqual(["O", "H"]);
  });

  it("returns null for PDB text without coordinate rows", () => {
    expect(parseStructureForFallback("bad.pdb", "ATOM  1  C   LIG")).toBeNull();
  });
});
