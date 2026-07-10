export interface VaspEnergyStep {
  step: number;
  energyEv: number;
  kind: "ionic" | "electronic";
}

export interface VaspSummary {
  format: "oszicar" | "outcar" | "vasprun" | "unknown";
  finalEnergyEv: number | null;
  sigmaZeroEnergyEv: number | null;
  convergedElectronic: boolean;
  ionicSteps: number;
  electronicSteps: number;
  warnings: string[];
  energySeries: VaspEnergyStep[];
}

const FLOAT = "[-+]?(?:\\d+\\.\\d*|\\.\\d+|\\d+)(?:[Ee][-+]?\\d+)?";
const F_RE = new RegExp(`^\\s*(\\d+)\\s+F=\\s*(${FLOAT})`);
const E0_RE = new RegExp(`\\bE0=\\s*(${FLOAT})`);
const ELECTRONIC_RE = new RegExp(`^\\s*(?:DAV|RMM|CG)\\s*:?\\s*(\\d+)\\s+(${FLOAT})`);
const TOTEN_RE = new RegExp(`free\\s+energy\\s+TOTEN\\s*=\\s*(${FLOAT})`, "i");
const SIGMA0_RE = new RegExp(`energy\\(sigma->0\\)\\s*=\\s*(${FLOAT})`, "i");
const WARNING_RE = /\b(?:warning|error|zbrent|brmix|edddav|sub-space-matrix|not positive definite)\b/i;

export function summarizeVaspFile(filename: string, text: string): VaspSummary {
  const base = (filename.split(/[\\/]/).pop() ?? filename).toLowerCase();
  if (base === "oszicar" || base.startsWith("oszicar.")) return summarizeOszicar(text);
  if (base === "outcar" || base.startsWith("outcar.")) return summarizeOutcar(text);
  if (base === "vasprun.xml" || base.endsWith(".vasprun.xml")) return summarizeVasprun(text);
  return emptySummary("unknown");
}

export function summarizeOszicar(text: string): VaspSummary {
  const summary = emptySummary("oszicar");
  let electronicSteps = 0;
  for (const line of text.split(/\r?\n/)) {
    const f = line.match(F_RE);
    if (f) {
      const step = Number(f[1]);
      const energy = Number(f[2]);
      summary.ionicSteps = Math.max(summary.ionicSteps, step);
      summary.finalEnergyEv = energy;
      summary.energySeries.push({ step, energyEv: energy, kind: "ionic" });
      const e0 = line.match(E0_RE);
      if (e0) summary.sigmaZeroEnergyEv = Number(e0[1]);
      continue;
    }
    const electronic = line.match(ELECTRONIC_RE);
    if (electronic) {
      electronicSteps += 1;
      summary.electronicSteps = electronicSteps;
      summary.energySeries.push({
        step: electronicSteps,
        energyEv: Number(electronic[2]),
        kind: "electronic",
      });
    }
    collectWarning(summary, line);
  }
  return summary;
}

export function summarizeOutcar(text: string): VaspSummary {
  const summary = emptySummary("outcar");
  for (const line of text.split(/\r?\n/)) {
    const toten = line.match(TOTEN_RE);
    if (toten) {
      summary.finalEnergyEv = Number(toten[1]);
      summary.ionicSteps += 1;
      summary.energySeries.push({ step: summary.ionicSteps, energyEv: summary.finalEnergyEv, kind: "ionic" });
    }
    const sigma0 = line.match(SIGMA0_RE);
    if (sigma0) summary.sigmaZeroEnergyEv = Number(sigma0[1]);
    if (/reached required accuracy/i.test(line)) summary.convergedElectronic = true;
    if (/Iteration\s+\d+\(/.test(line)) summary.electronicSteps += 1;
    collectWarning(summary, line);
  }
  return summary;
}

function summarizeVasprun(text: string): VaspSummary {
  const summary = emptySummary("vasprun");
  for (const m of text.matchAll(/<i\s+name="e_fr_energy">\s*([^<\s]+)\s*<\/i>/g)) {
    const value = Number(m[1]);
    if (Number.isFinite(value)) {
      summary.finalEnergyEv = value;
      summary.ionicSteps += 1;
      summary.energySeries.push({ step: summary.ionicSteps, energyEv: value, kind: "ionic" });
    }
  }
  return summary;
}

function collectWarning(summary: VaspSummary, line: string) {
  if (!WARNING_RE.test(line)) return;
  const trimmed = line.trim();
  if (trimmed && summary.warnings.length < 8) summary.warnings.push(trimmed.slice(0, 220));
}

function emptySummary(format: VaspSummary["format"]): VaspSummary {
  return {
    format,
    finalEnergyEv: null,
    sigmaZeroEnergyEv: null,
    convergedElectronic: false,
    ionicSteps: 0,
    electronicSteps: 0,
    warnings: [],
    energySeries: [],
  };
}
