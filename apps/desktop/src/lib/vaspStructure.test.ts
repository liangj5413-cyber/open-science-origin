import { describe, expect, it } from "vitest";
import {
  isVaspStructureFile,
  parseVaspStructure,
  summarizeVaspStructure,
  vaspStructureToStructureJson,
  vaspStructureToVasp5,
} from "./vaspStructure";

const POSCAR_SI = `Si conventional cell synthetic fixture
5.431
1.0 0.0 0.0
0.0 1.0 0.0
0.0 0.0 1.0
Si
2
Direct
0.000000 0.000000 0.000000
0.250000 0.250000 0.250000
`;

describe("isVaspStructureFile", () => {
  it("recognizes VASP structure names with or without extensions", () => {
    expect(isVaspStructureFile("POSCAR")).toBe(true);
    expect(isVaspStructureFile("CONTCAR")).toBe(true);
    expect(isVaspStructureFile("run/POSCAR_Si")).toBe(true);
    expect(isVaspStructureFile("POSCAR.relaxed")).toBe(true);
    expect(isVaspStructureFile("cell.vasp")).toBe(true);
    expect(isVaspStructureFile("report.txt")).toBe(false);
  });
});

describe("parseVaspStructure", () => {
  it("parses the auto-simulation POSCAR_Si fixture into StructureJSON-ready data", () => {
    const structure = parseVaspStructure(POSCAR_SI);

    expect(structure.species).toEqual(["Si"]);
    expect(structure.counts).toEqual([2]);
    expect(structure.coordinateMode).toBe("direct");
    expect(structure.lattice[0]).toEqual([5.431, 0, 0]);
    expect(structure.atoms).toHaveLength(2);
    expect(structure.atoms[1].fractional).toEqual([0.25, 0.25, 0.25]);
    expect(structure.atoms[1].cartesian[0]).toBeCloseTo(1.35775, 5);

    const json = vaspStructureToStructureJson(structure);
    expect(json.pbc).toEqual([true, true, true]);
    expect(json.atoms[0]).toMatchObject({ element: "Si", coords_are_cartesian: false });
    expect(json.properties.formula).toBe("Si2");
  });

  it("supports VASP4 count-only files by inferring symbols from the comment", () => {
    const structure = parseVaspStructure(`Fe O test
1.0
2 0 0
0 2 0
0 0 2
1 2
Cartesian
0 0 0
0.5 0.5 0.5
1.0 1.0 1.0
`);

    expect(structure.species).toEqual(["Fe", "O"]);
    expect(structure.atoms.map((atom) => atom.element)).toEqual(["Fe", "O", "O"]);
    expect(structure.atoms[1].cartesian).toEqual([0.5, 0.5, 0.5]);
  });

  it("normalizes selective dynamics files before handing them to the viewer", () => {
    const structure = parseVaspStructure(`C selective fixture
1.0
3 0 0
0 3 0
0 0 3
C
1
selective dynamics
direct
0.1 0.2 0.3 T F T
`);
    const normalized = vaspStructureToVasp5(structure);

    expect(structure.selectiveDynamics).toBe(true);
    expect(normalized).toContain("\nC\n1\nDirect\n");
    expect(normalized).not.toMatch(/\n\s*selective dynamics\s*\n/i);
    expect(normalized).not.toContain("T F T");
  });

  it("reports malformed POSCAR content clearly", () => {
    expect(() => parseVaspStructure("bad\n1\n0 0 0\n")).toThrow(/incomplete/i);
    expect(() =>
      parseVaspStructure(`bad mode
1
1 0 0
0 1 0
0 0 1
Si
1
Unknown
0 0 0
`),
    ).toThrow(/Direct or Cartesian/);
  });
});

describe("vaspStructureToVasp5", () => {
  it("emits VASP5 text that keeps the structure summary stable", () => {
    const structure = parseVaspStructure(POSCAR_SI);
    const normalized = vaspStructureToVasp5(structure);

    expect(normalized).toContain("Si\n2\nDirect\n");
    expect(normalized).toContain("0.25 0.25 0.25");
    expect(summarizeVaspStructure(structure)).toBe("Si2 | Direct | a=5.431 A b=5.431 A c=5.431 A");
  });
});
