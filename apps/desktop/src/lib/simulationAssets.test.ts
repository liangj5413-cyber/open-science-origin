import { describe, expect, it } from "vitest";
import { classifySimulationAsset, simulationAssetBadge } from "./simulationAssets";

describe("classifySimulationAsset", () => {
  it("recognizes VASP fixed-name inputs and outputs", () => {
    expect(classifySimulationAsset("calc/POSCAR_Si")).toMatchObject({ kind: "structure", format: "poscar" });
    expect(classifySimulationAsset("calc/CONTCAR.final")).toMatchObject({ kind: "structure", format: "contcar" });
    expect(classifySimulationAsset("calc/INCAR")).toMatchObject({ kind: "vasp-input", format: "incar" });
    expect(classifySimulationAsset("calc/KPOINTS")).toMatchObject({ kind: "vasp-input", format: "kpoints" });
    expect(classifySimulationAsset("calc/OSZICAR")).toMatchObject({ kind: "vasp-output", format: "oszicar" });
    expect(classifySimulationAsset("calc/OUTCAR")).toMatchObject({ kind: "vasp-output", format: "outcar" });
  });

  it("marks POTCAR as restricted rather than a previewable text file", () => {
    expect(classifySimulationAsset("POTCAR")).toMatchObject({
      kind: "restricted",
      format: "potcar",
      restricted: true,
    });
  });

  it("marks credential-like paths as restricted", () => {
    expect(classifySimulationAsset("secrets/data.txt")).toMatchObject({
      kind: "restricted",
      format: "credential",
      restricted: true,
    });
    expect(classifySimulationAsset("run/api_key.txt")).toMatchObject({
      kind: "restricted",
      format: "credential",
      restricted: true,
    });
  });

  it("recognizes workflow and run manifest yaml names", () => {
    expect(classifySimulationAsset("workflow.vasp_relax.yaml")).toMatchObject({ kind: "workflow" });
    expect(classifySimulationAsset("runs/manifest.yaml")).toMatchObject({ kind: "run", format: "manifest" });
    expect(simulationAssetBadge("OUTCAR")).toBe("OUTCAR");
    expect(simulationAssetBadge("README.md")).toBeNull();
    expect(simulationAssetBadge("scripts/analyze.py")).toBeNull();
  });
});
