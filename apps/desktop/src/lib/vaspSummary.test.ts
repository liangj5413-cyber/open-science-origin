import { describe, expect, it } from "vitest";
import { summarizeOszicar, summarizeOutcar, summarizeVaspFile } from "./vaspSummary";

describe("vaspSummary", () => {
  it("extracts ionic energies from OSZICAR", () => {
    const summary = summarizeOszicar(`
DAV:   1    -0.100000E+02
   1 F= -.10500000E+02 E0= -.10400000E+02  d E =-.1E+00
   2 F= -.10600000E+02 E0= -.10550000E+02  d E =-.1E+00
`);
    expect(summary.format).toBe("oszicar");
    expect(summary.ionicSteps).toBe(2);
    expect(summary.electronicSteps).toBe(1);
    expect(summary.finalEnergyEv).toBeCloseTo(-10.6);
    expect(summary.sigmaZeroEnergyEv).toBeCloseTo(-10.55);
  });

  it("extracts OUTCAR final energy, convergence, and warnings", () => {
    const summary = summarizeOutcar(`
 free  energy   TOTEN  =       -12.345678 eV
 energy(sigma->0) =       -12.300000
 reached required accuracy - stopping structural energy minimisation
 WARNING: Sub-Space-Matrix is not hermitian
`);
    expect(summary.format).toBe("outcar");
    expect(summary.finalEnergyEv).toBeCloseTo(-12.345678);
    expect(summary.sigmaZeroEnergyEv).toBeCloseTo(-12.3);
    expect(summary.convergedElectronic).toBe(true);
    expect(summary.warnings[0]).toContain("WARNING");
  });

  it("dispatches by file name", () => {
    expect(summarizeVaspFile("OSZICAR", " 1 F= -1.0 E0= -0.9").format).toBe("oszicar");
    expect(summarizeVaspFile("OUTCAR", "free energy TOTEN = -2.0 eV").format).toBe("outcar");
  });
});
