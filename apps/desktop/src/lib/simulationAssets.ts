export type SimulationAssetKind =
  | "structure"
  | "vasp-input"
  | "vasp-output"
  | "workflow"
  | "run"
  | "report"
  | "source"
  | "restricted"
  | "unknown";

export type SimulationAssetFormat =
  | "poscar"
  | "contcar"
  | "cif"
  | "xyz"
  | "pdb"
  | "mol2"
  | "incar"
  | "kpoints"
  | "potcar"
  | "oszicar"
  | "outcar"
  | "vasprun"
  | "doscar"
  | "eigenval"
  | "chgcar"
  | "locpot"
  | "xdatcar"
  | "yaml"
  | "manifest"
  | "markdown"
  | "python"
  | "credential"
  | "unknown";

export interface SimulationAssetInfo {
  kind: SimulationAssetKind;
  format: SimulationAssetFormat;
  label: string;
  previewTypes: string[];
  restricted?: boolean;
}

const STRUCTURE_EXTS = new Set(["vasp", "poscar", "contcar", "cif", "mcif", "mmcif", "xyz", "pdb", "pdbqt", "mol2"]);

function baseName(path: string): string {
  return (path.split(/[\\/]/).pop() ?? path).toLowerCase();
}

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

function fixedVaspName(base: string, fixed: string): boolean {
  return (
    base === fixed ||
    base.startsWith(`${fixed}.`) ||
    base.startsWith(`${fixed}_`) ||
    base.startsWith(`${fixed}-`)
  );
}

function credentialLike(path: string): boolean {
  const normalized = path.toLowerCase();
  const base = baseName(path);
  return (
    /(^|[\\/._-])(secret|secrets|credential|credentials|token|api[_-]?key|private[_-]?key)([\\/._-]|$)/.test(normalized) ||
    base === "id_rsa" ||
    base === "id_dsa" ||
    base === "id_ecdsa" ||
    base === "id_ed25519" ||
    base.endsWith(".pem") ||
    base.endsWith(".key")
  );
}

export function classifySimulationAsset(path: string): SimulationAssetInfo {
  const base = baseName(path);
  const ext = extOf(base);

  if (credentialLike(path)) {
    return {
      kind: "restricted",
      format: "credential",
      label: "restricted",
      previewTypes: ["restricted"],
      restricted: true,
    };
  }

  if (fixedVaspName(base, "potcar")) {
    return {
      kind: "restricted",
      format: "potcar",
      label: "POTCAR",
      previewTypes: ["restricted"],
      restricted: true,
    };
  }
  if (fixedVaspName(base, "poscar")) return structure("poscar", "POSCAR");
  if (fixedVaspName(base, "contcar")) return structure("contcar", "CONTCAR");

  if (base === "incar" || base.startsWith("incar.")) {
    return { kind: "vasp-input", format: "incar", label: "INCAR", previewTypes: ["code"] };
  }
  if (base === "kpoints" || base.startsWith("kpoints.")) {
    return { kind: "vasp-input", format: "kpoints", label: "KPOINTS", previewTypes: ["code"] };
  }

  if (base === "oszicar" || base.startsWith("oszicar.")) {
    return { kind: "vasp-output", format: "oszicar", label: "OSZICAR", previewTypes: ["summary", "code"] };
  }
  if (base === "outcar" || base.startsWith("outcar.")) {
    return { kind: "vasp-output", format: "outcar", label: "OUTCAR", previewTypes: ["summary", "code"] };
  }
  if (base === "vasprun.xml" || base.endsWith(".vasprun.xml")) {
    return { kind: "vasp-output", format: "vasprun", label: "vasprun", previewTypes: ["summary", "code"] };
  }
  if (base === "doscar" || base.startsWith("doscar.")) {
    return { kind: "vasp-output", format: "doscar", label: "DOSCAR", previewTypes: ["dos"] };
  }
  if (base === "eigenval" || base.startsWith("eigenval.")) {
    return { kind: "vasp-output", format: "eigenval", label: "EIGENVAL", previewTypes: ["bands"] };
  }
  if (base === "chgcar" || base.startsWith("chgcar.")) {
    return { kind: "vasp-output", format: "chgcar", label: "CHGCAR", previewTypes: ["large-file"] };
  }
  if (base === "locpot" || base.startsWith("locpot.")) {
    return { kind: "vasp-output", format: "locpot", label: "LOCPOT", previewTypes: ["large-file"] };
  }
  if (base === "xdatcar" || base.startsWith("xdatcar.")) {
    return { kind: "vasp-output", format: "xdatcar", label: "XDATCAR", previewTypes: ["large-file"] };
  }

  if (STRUCTURE_EXTS.has(ext)) return structure(ext as SimulationAssetFormat, ext.toUpperCase());

  if (base === "manifest.yaml" || base === "manifest.yml" || base === "run_manifest.yaml" || base === "run_manifest.yml") {
    return { kind: "run", format: "manifest", label: "manifest", previewTypes: ["run-monitor", "code"] };
  }
  if (ext === "yaml" || ext === "yml") {
    return { kind: "workflow", format: "yaml", label: "workflow", previewTypes: ["workflow", "code"] };
  }
  if (ext === "md") return { kind: "report", format: "markdown", label: "report", previewTypes: ["markdown"] };
  if (["py", "sh", "ts", "js"].includes(ext)) {
    return { kind: "source", format: ext === "py" ? "python" : "unknown", label: "source", previewTypes: ["code"] };
  }
  return { kind: "unknown", format: "unknown", label: "file", previewTypes: [] };
}

export function simulationAssetBadge(path: string): string | null {
  const info = classifySimulationAsset(path);
  if (info.kind === "unknown" || info.kind === "report" || info.kind === "source") return null;
  return info.label;
}

function structure(format: SimulationAssetFormat, label: string): SimulationAssetInfo {
  return { kind: "structure", format, label, previewTypes: ["structure", "code"] };
}
