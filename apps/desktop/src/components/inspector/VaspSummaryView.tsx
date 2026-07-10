import { AlertTriangle, CheckCircle2, Sigma } from "lucide-react";
import { useTranslation } from "react-i18next";
import { summarizeVaspFile, type VaspSummary } from "@/lib/vaspSummary";

export function VaspSummaryView({ filename, text }: { filename: string; text: string }) {
  const { t } = useTranslation("inspector");
  const summary = summarizeVaspFile(filename, text);
  return (
    <div className="min-h-full bg-surface-2 p-4 text-sm text-text">
      <div className="rounded-input border border-border bg-surface p-4 shadow-card">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-input bg-accent/10 text-accent">
            <Sigma size={17} strokeWidth={1.75} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-serif text-lg leading-tight">{filename}</h2>
            <p className="mt-0.5 text-xs text-muted">{t("vaspSummary.description")}</p>
          </div>
          <span className="rounded bg-surface-2 px-2 py-1 text-xs uppercase text-muted">{summary.format}</span>
        </div>

        <SummaryGrid summary={summary} />

        {summary.energySeries.length > 0 && (
          <div className="mt-4">
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted">{t("vaspSummary.energyTrace")}</div>
            <div className="max-h-52 overflow-auto rounded-input border border-border bg-surface-2">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-border text-muted">
                    <th className="px-2 py-1.5 font-medium">{t("vaspSummary.step")}</th>
                    <th className="px-2 py-1.5 font-medium">{t("vaspSummary.kind")}</th>
                    <th className="px-2 py-1.5 font-medium">{t("vaspSummary.energyEv")}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.energySeries.slice(-200).map((p, i) => (
                    <tr key={`${p.kind}-${p.step}-${i}`} className="border-b border-border/60 last:border-0">
                      <td className="px-2 py-1.5 font-mono">{p.step}</td>
                      <td className="px-2 py-1.5">
                        {t(p.kind === "ionic" ? "vaspSummary.energyKind.ionic" : "vaspSummary.energyKind.electronic")}
                      </td>
                      <td className="px-2 py-1.5 font-mono">{p.energyEv.toFixed(8)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {summary.warnings.length > 0 && (
          <div className="mt-4 rounded-input border border-warn/30 bg-warn/10 p-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-warn">
              <AlertTriangle size={13} /> {t("vaspSummary.warnings")}
            </div>
            <ul className="space-y-1 font-mono text-xs text-text">
              {summary.warnings.map((w, i) => (
                <li key={`${w}-${i}`}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryGrid({ summary }: { summary: VaspSummary }) {
  const { t } = useTranslation("inspector");
  const rows = [
    [t("vaspSummary.finalEnergy"), summary.finalEnergyEv === null ? t("vaspSummary.notFound") : `${summary.finalEnergyEv.toFixed(8)} eV`],
    [t("vaspSummary.sigmaZero"), summary.sigmaZeroEnergyEv === null ? t("vaspSummary.notFound") : `${summary.sigmaZeroEnergyEv.toFixed(8)} eV`],
    [t("vaspSummary.ionicSteps"), String(summary.ionicSteps)],
    [t("vaspSummary.electronicSteps"), String(summary.electronicSteps)],
  ];
  return (
    <div className="mt-4 grid gap-2 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="rounded-input border border-border bg-surface-2 px-3 py-2">
          <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
          <div className="mt-0.5 font-mono text-[13px]">{value}</div>
        </div>
      ))}
      <div className="rounded-input border border-border bg-surface-2 px-3 py-2 sm:col-span-2">
        <div className="text-[11px] uppercase tracking-wide text-muted">{t("vaspSummary.electronicConvergence")}</div>
        <div className="mt-1 flex items-center gap-1.5 text-[13px]">
          {summary.convergedElectronic ? (
            <>
              <CheckCircle2 size={14} className="text-ok" /> {t("vaspSummary.reachedAccuracy")}
            </>
          ) : (
            <span className="text-muted">{t("vaspSummary.noConvergenceMarker")}</span>
          )}
        </div>
      </div>
    </div>
  );
}
