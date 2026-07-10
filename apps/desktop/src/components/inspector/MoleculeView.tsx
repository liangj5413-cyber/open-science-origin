import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { CartoonStyleSpec, ColorschemeSpec, GLViewer, SurfaceStyleSpec } from "3dmol";
import {
  Aperture,
  Atom,
  Box,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Download,
  Film,
  Grid3X3,
  Image,
  Info,
  Layers,
  Palette,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Ruler,
  ScanSearch,
  Tags,
  Triangle,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  defaultStyleMode,
  isSmilesFile,
  looksLikeMacromolecule,
  moleculeFormatFor,
  smilesToMolblock,
  type MoleculeStyleMode,
} from "@/lib/molecule";
import {
  parseStructureForFallback,
  structureFormula,
  type SimpleStructure,
  type SimpleStructureAtom,
} from "@/lib/structureFallback";
import {
  isVaspStructureFile,
  parseVaspStructure,
  summarizeVaspStructure,
  vaspStructureToVasp5,
} from "@/lib/vaspStructure";
import { cn } from "@/lib/cn";

const STYLE_OPTIONS: Array<{ value: MoleculeStyleMode }> = [
  { value: "stick" },
  { value: "sphere" },
  { value: "cartoon" },
  { value: "line" },
  { value: "cross" },
];

const RAW_TEXT_PREVIEW_LIMIT = 80_000;
const SIZE_WAIT_FRAMES = 2;
const ATOM_LABEL_LIMIT = 320;
const RESIDUE_LABEL_LIMIT = 450;
const SURFACE_ATOM_LIMIT = 5_000;

type RenderPhase = "prepare" | "load" | "viewer" | "parse" | "style" | "render";
type MeasurementMode = "none" | "distance" | "angle";
type SurfaceType = "VDW" | "SAS" | "MS" | "SES";
type SurfaceColorMode = "solid" | "element" | "charge" | "cube";
type SurfaceScope = "all" | "selection" | "hetero" | "polymer";
type SelectionPreset = "all" | "nonH" | "hetero" | "polymer";
type SelectionAction = "none" | "highlight" | "hide" | "focus";
type CartoonStyle = "default" | "trace" | "tube" | "arrow";
type ViewEffect = "none" | "outline" | "ambientOcclusion";
type TrajectoryLoop = "forward" | "backAndForth";
type MoleculeAtom = {
  atom?: string;
  chain?: string;
  elem?: string;
  index?: number;
  resi?: number | string;
  resn?: string;
  serial?: number | string;
  x?: number;
  y?: number;
  z?: number;
};
type MeasurementRefs = {
  shapes: MutableRefObject<unknown[]>;
  labels: MutableRefObject<unknown[]>;
};
type UnitCellViewer = GLViewer & {
  addUnitCell?: (model?: unknown, spec?: unknown) => void;
  replicateUnitCell?: (a?: number, b?: number, c?: number, model?: unknown, addBonds?: boolean, prune?: unknown) => void;
  removeUnitCell?: (model?: unknown) => void;
};
type EnhancedViewer = GLViewer & {
  addIsosurface?: (data: unknown, spec?: unknown, callback?: unknown) => unknown;
  addVolumetricData?: (data: unknown, format: string, spec?: unknown) => unknown;
  mapAtomProperties?: (mapper: unknown, sel?: unknown) => void;
};
type ThreeDmolModule = typeof import("3dmol");
type OffscreenCanvasGlobal = {
  OffscreenCanvas: typeof OffscreenCanvas | undefined;
};

let offscreenCanvasHasWebGl: boolean | null = null;
const THREE_DMOL_PARSER_OPTIONS = { keepH: true };
const DEFAULT_REPLICATE_INPUT = "1x1x1";
const MAX_REPLICATE_AXIS = 8;
const MAX_REPLICATE_CELLS = 512;

/**
 * Interactive 3D structure viewer (P1-3) for chemical files
 * (cif/pdb/mol/mol2/sdf/xyz/pqr/cube and SMILES). 3Dmol.js renders a rotatable,
 * zoomable model entirely locally via WebGL — no service. SMILES has no
 * coordinates, so it is converted to a molblock first. The scene sits on a
 * white stage (chemistry convention), consistent in light and dark themes.
 */
export function MoleculeView({ filename, text }: { filename: string; text: string }) {
  const { t } = useTranslation(["inspector", "common"]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<GLViewer | null>(null);
  const atomLabelsRef = useRef<unknown[]>([]);
  const residueLabelsRef = useRef<unknown[]>([]);
  const measurementLabelsRef = useRef<unknown[]>([]);
  const measurementShapesRef = useRef<unknown[]>([]);
  const surfaceIdRef = useRef<number | null>(null);
  const surfaceViewerRef = useRef<GLViewer | null>(null);
  const isosurfaceShapeRef = useRef<unknown | null>(null);
  const isosurfaceViewerRef = useRef<GLViewer | null>(null);
  const atomClickHandlerRef = useRef<(atom: MoleculeAtom) => void>(() => {});
  const atomPickingRegisteredRef = useRef(false);
  const measurementModeRef = useRef<MeasurementMode>("none");
  const showAtomInfoRef = useRef(false);
  const threeDmolRef = useRef<ThreeDmolModule | null>(null);

  const format = useMemo(() => moleculeFormatFor(filename), [filename]);
  const isMacromolecule = useMemo(() => looksLikeMacromolecule(text), [text]);
  const supportsUnitCell = useMemo(() => supportsUnitCellPreview(filename, format), [filename, format]);
  // Cartoon depicts a residue backbone — meaningless for small molecules, and
  // 3Dmol crashes reading a missing atom.resn. Offer it only for macromolecules.
  const styleOptions = useMemo(
    () => STYLE_OPTIONS.filter((o) => o.value !== "cartoon" || isMacromolecule),
    [isMacromolecule],
  );

  const [styleMode, setStyleMode] = useState<MoleculeStyleMode>(() =>
    defaultStyleMode(filename, text),
  );
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [atomCount, setAtomCount] = useState<number | null>(null);
  const [atoms, setAtoms] = useState<MoleculeAtom[]>([]);
  const [frameCount, setFrameCount] = useState(1);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [hasFrames, setHasFrames] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [showAdvancedControls, setShowAdvancedControls] = useState(false);
  const [viewerVersion, setViewerVersion] = useState(0);
  const [structureSummary, setStructureSummary] = useState<string | null>(null);
  const [fallbackStructure, setFallbackStructure] = useState<SimpleStructure | null>(null);
  const [fallbackNotice, setFallbackNotice] = useState<string | null>(null);
  const [showAtomInfo, setShowAtomInfo] = useState(false);
  const [selectedAtom, setSelectedAtom] = useState<MoleculeAtom | null>(null);
  const [showAtomLabels, setShowAtomLabels] = useState(false);
  const [showResidueLabels, setShowResidueLabels] = useState(false);
  const [measurementMode, setMeasurementMode] = useState<MeasurementMode>("none");
  const [, setMeasurementAtoms] = useState<MoleculeAtom[]>([]);
  const [measurementText, setMeasurementText] = useState<string | null>(null);
  const [showSurface, setShowSurface] = useState(false);
  const [surfaceType, setSurfaceType] = useState<SurfaceType>("VDW");
  const [surfaceColor, setSurfaceColor] = useState("#dbe3ee");
  const [surfaceOpacity, setSurfaceOpacity] = useState(0.35);
  const [surfaceColorMode, setSurfaceColorMode] = useState<SurfaceColorMode>("solid");
  const [surfaceScope, setSurfaceScope] = useState<SurfaceScope>("all");
  const [showIsosurface, setShowIsosurface] = useState(false);
  const [isosurfaceValue, setIsosurfaceValue] = useState(0.01);
  const [isosurfaceColor, setIsosurfaceColor] = useState("#2563eb");
  const [isosurfaceOpacity, setIsosurfaceOpacity] = useState(0.65);
  const [showUnitCell, setShowUnitCell] = useState(supportsUnitCell);
  const [showUnitCellLabels, setShowUnitCellLabels] = useState(false);
  const [replicateInput, setReplicateInput] = useState(DEFAULT_REPLICATE_INPUT);
  const [appliedReplicateInput, setAppliedReplicateInput] = useState(DEFAULT_REPLICATE_INPUT);
  const [selectionPreset, setSelectionPreset] = useState<SelectionPreset>("all");
  const [selectionElement, setSelectionElement] = useState("");
  const [selectionChain, setSelectionChain] = useState("");
  const [selectionResidue, setSelectionResidue] = useState("");
  const [selectionIndex, setSelectionIndex] = useState("");
  const [selectionAction, setSelectionAction] = useState<SelectionAction>("none");
  const [cartoonStyle, setCartoonStyle] = useState<CartoonStyle>("default");
  const [colorMode, setColorMode] = useState("jmol");
  const [viewEffect, setViewEffect] = useState<ViewEffect>("none");
  const [orthographic, setOrthographic] = useState(false);
  const [trajectorySpeed, setTrajectorySpeed] = useState(90);
  const [trajectoryLoop, setTrajectoryLoop] = useState<TrajectoryLoop>("forward");
  const [toolNotice, setToolNotice] = useState<string | null>(null);
  const rawTextPreview = useMemo(() => {
    if (text.length <= RAW_TEXT_PREVIEW_LIMIT) return text || "(empty file)";
    return `${text.slice(0, RAW_TEXT_PREVIEW_LIMIT)}\n[raw text preview truncated]`;
  }, [text]);
  const selectionSpec = useMemo(
    () =>
      buildSelectionSpec({
        preset: selectionPreset,
        element: selectionElement,
        chain: selectionChain,
        residue: selectionResidue,
        index: selectionIndex,
      }),
    [selectionChain, selectionElement, selectionIndex, selectionPreset, selectionResidue],
  );
  const atomPickingEnabled = showAtomInfo || measurementMode !== "none";

  useEffect(() => {
    setStyleMode(defaultStyleMode(filename, text));
    setShowUnitCell(supportsUnitCellPreview(filename, moleculeFormatFor(filename)));
    setShowAtomInfo(false);
    showAtomInfoRef.current = false;
    setSelectedAtom(null);
    setShowAtomLabels(false);
    setShowResidueLabels(false);
    setMeasurementMode("none");
    measurementModeRef.current = "none";
    setMeasurementAtoms([]);
    setMeasurementText(null);
    setShowSurface(false);
    setSurfaceType("VDW");
    setSurfaceColor("#dbe3ee");
    setSurfaceOpacity(0.35);
    setSurfaceColorMode(moleculeFormatFor(filename) === "cube" ? "cube" : "solid");
    setSurfaceScope("all");
    setShowIsosurface(false);
    setIsosurfaceValue(0.01);
    setIsosurfaceColor("#2563eb");
    setIsosurfaceOpacity(0.65);
    setShowUnitCellLabels(false);
    setReplicateInput(DEFAULT_REPLICATE_INPUT);
    setAppliedReplicateInput(DEFAULT_REPLICATE_INPUT);
    setSelectionPreset("all");
    setSelectionElement("");
    setSelectionChain("");
    setSelectionResidue("");
    setSelectionIndex("");
    setSelectionAction("none");
    setCartoonStyle("default");
    setColorMode("jmol");
    setViewEffect("none");
    setOrthographic(false);
    setTrajectorySpeed(90);
    setTrajectoryLoop("forward");
    setFrameCount(1);
    setCurrentFrame(0);
    setToolNotice(null);
    setHasFrames(false);
    setIsAnimating(false);
    setShowAdvancedControls(false);
  }, [filename, text]);

  const resetView = useCallback(() => {
    const v = viewerRef.current;
    if (!v) return;
    v.zoomTo();
    v.render();
  }, []);

  const applyReplicateInput = useCallback(() => {
    const parsed = parseReplicateInput(replicateInput);
    if (!parsed) {
      setReplicateInput(appliedReplicateInput);
      setToolNotice("Use cell replication as A x B x C integers, e.g. 2x2x1.");
      return;
    }
    setReplicateInput(parsed.label);
    setAppliedReplicateInput(parsed.label);
    setToolNotice(null);
  }, [appliedReplicateInput, replicateInput]);

  const resetReplication = useCallback(() => {
    setReplicateInput(DEFAULT_REPLICATE_INPUT);
    setAppliedReplicateInput(DEFAULT_REPLICATE_INPUT);
    setToolNotice(null);
  }, []);

  const handleAtomPick = useCallback((atom: MoleculeAtom) => {
    const picked = normalizeAtom(atom);
    if (showAtomInfoRef.current) setSelectedAtom(picked);

    const mode = measurementModeRef.current;
    if (mode === "none") return;
    setMeasurementAtoms((previous) => {
      const needed = mode === "distance" ? 2 : 3;
      const next = [...previous, picked].slice(-needed);
      const viewer = viewerRef.current;
      if (viewer) renderMeasurement(viewer, mode, next, { shapes: measurementShapesRef, labels: measurementLabelsRef });
      setMeasurementText(formatMeasurement(mode, next));
      return next;
    });
  }, []);

  useEffect(() => {
    atomClickHandlerRef.current = handleAtomPick;
  }, [handleAtomPick]);

  useEffect(() => {
    showAtomInfoRef.current = showAtomInfo;
    if (!showAtomInfo) setSelectedAtom(null);
  }, [showAtomInfo]);

  useEffect(() => {
    measurementModeRef.current = measurementMode;
    clearMeasurement(viewerRef.current, { shapes: measurementShapesRef, labels: measurementLabelsRef });
    setMeasurementAtoms([]);
    setMeasurementText(formatMeasurement(measurementMode, []));
  }, [measurementMode]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || fallbackStructure || error) return;
    if (!atomPickingEnabled && !atomPickingRegisteredRef.current) return;
    viewer.setClickable({}, atomPickingEnabled, (atom: MoleculeAtom) => atomClickHandlerRef.current(atom));
    atomPickingRegisteredRef.current = atomPickingEnabled;
  }, [atomPickingEnabled, error, fallbackStructure, viewerVersion]);

  useEffect(() => {
    clearMeasurement(viewerRef.current, { shapes: measurementShapesRef, labels: measurementLabelsRef });
    setMeasurementAtoms([]);
    setMeasurementText(null);
    setIsAnimating(false);
  }, [viewerVersion]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || fallbackStructure || error) return;
    syncLabels(viewer, atoms, {
      atomLabelsRef,
      residueLabelsRef,
      showAtomLabels,
      showResidueLabels,
      isMacromolecule,
      setToolNotice,
    });
    return () => {
      clearLabels(viewer, atomLabelsRef);
      clearLabels(viewer, residueLabelsRef);
    };
  }, [atoms, error, fallbackStructure, isMacromolecule, showAtomLabels, showResidueLabels, viewerVersion]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || fallbackStructure || error) return;
    if (!showSurface) {
      clearSurface(surfaceViewerRef.current ?? viewer, surfaceIdRef);
      return;
    }
    if (atoms.length > SURFACE_ATOM_LIMIT) {
      setToolNotice(`Surface skipped: ${atoms.length} atoms is above the local preview limit.`);
      return;
    }

    let cancelled = false;
    surfaceViewerRef.current = viewer;
    try {
      const style = buildSurfaceStyle({
        color: surfaceColor,
        colorMode: surfaceColorMode,
        format,
        module: threeDmolRef.current,
        opacity: surfaceOpacity,
        text,
        viewer,
      });
      const surface = viewer.addSurface(surfaceType, style, surfaceSelection(surfaceScope, selectionSpec), {});
      const immediateId = surfaceIdFrom(surface);
      if (immediateId !== null) surfaceIdRef.current = immediateId;
      if (isPromiseLike(surface)) {
        Promise.resolve(surface).then(
          (id) => {
            const surfaceId = surfaceIdFrom(id) ?? surfaceIdFrom(surface);
            if (surfaceId !== null) surfaceIdRef.current = surfaceId;
            if (cancelled) clearSurface(viewer, surfaceIdRef);
            else viewer.render();
          },
          (surfaceError: unknown) => {
            if (!cancelled) {
              setToolNotice(`Surface failed: ${normalizeViewerError(surfaceError)}`);
              setShowSurface(false);
            }
          },
        );
      }
      viewer.render();
    } catch (surfaceError) {
      setToolNotice(`Surface failed: ${normalizeViewerError(surfaceError)}`);
      setShowSurface(false);
    }
    return () => {
      cancelled = true;
      clearSurface(viewer, surfaceIdRef);
    };
  }, [
    atoms.length,
    error,
    fallbackStructure,
    format,
    selectionSpec,
    showSurface,
    surfaceColor,
    surfaceColorMode,
    surfaceOpacity,
    surfaceScope,
    surfaceType,
    text,
    viewerVersion,
  ]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || fallbackStructure || error || format !== "cube") return;
    if (!showIsosurface) {
      clearShape(isosurfaceViewerRef.current ?? viewer, isosurfaceShapeRef);
      return;
    }

    isosurfaceViewerRef.current = viewer;
    try {
      const volumeData = cubeVolumeData(threeDmolRef.current, text);
      const spec = {
        color: isosurfaceColor,
        isoval: isosurfaceValue,
        opacity: isosurfaceOpacity,
      };
      const shape = (viewer as EnhancedViewer).addIsosurface?.(volumeData, spec);
      isosurfaceShapeRef.current =
        shape ?? (viewer as EnhancedViewer).addVolumetricData?.(text, "cube", spec) ?? null;
      viewer.render();
    } catch (isoError) {
      setToolNotice(`Isosurface failed: ${normalizeViewerError(isoError)}`);
      setShowIsosurface(false);
    }

    return () => {
      clearShape(viewer, isosurfaceShapeRef);
    };
  }, [
    error,
    fallbackStructure,
    format,
    isosurfaceColor,
    isosurfaceOpacity,
    isosurfaceValue,
    showIsosurface,
    text,
    viewerVersion,
  ]);

  const toggleMeasurementMode = useCallback((mode: Exclude<MeasurementMode, "none">) => {
    setMeasurementMode((current) => (current === mode ? "none" : mode));
  }, []);

  const toggleAnimation = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer || !hasFrames) return;
    if (isAnimating) {
      viewer.stopAnimate();
      setIsAnimating(false);
    } else {
      viewer.animate({ loop: trajectoryLoop, reps: 0, interval: trajectorySpeed });
      setIsAnimating(true);
    }
    viewer.render();
  }, [hasFrames, isAnimating, trajectoryLoop, trajectorySpeed]);

  const goToFrame = useCallback((frame: number) => {
    const viewer = viewerRef.current;
    if (!viewer || frameCount <= 1) return;
    const next = Math.max(0, Math.min(frameCount - 1, frame));
    viewer.stopAnimate();
    setIsAnimating(false);
    setCurrentFrame(next);
    void viewer.setFrame(next).then(() => {
      viewer.render();
      setCurrentFrame(viewer.getFrame?.() ?? next);
    });
  }, [frameCount]);

  const stepFrame = useCallback((delta: number) => {
    goToFrame(currentFrame + delta);
  }, [currentFrame, goToFrame]);

  const exportApng = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer || frameCount <= 1) return;
    void viewer
      .apngURI(frameCount)
      .then((uri) => {
        const link = document.createElement("a");
        link.href = String(uri);
        link.download = `${safePngStem(filename)}.apng`;
        document.body.append(link);
        link.click();
        link.remove();
        setToolNotice("APNG export started.");
      })
      .catch((exportError) => setToolNotice(`APNG export failed: ${normalizeViewerError(exportError)}`));
  }, [filename, frameCount]);

  const addVibrationFrames = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    try {
      viewer.vibrate(12, 1, true, { color: "#f59e0b", radius: 0.08 });
      const frames = Math.max(1, viewer.getNumFrames());
      setFrameCount(frames);
      setHasFrames(frames > 1);
      setCurrentFrame(0);
      setToolNotice(frames > 1 ? "Vibration frames generated." : "No vibration vectors were found.");
      viewer.render();
    } catch (vibrationError) {
      setToolNotice(`Vibration failed: ${normalizeViewerError(vibrationError)}`);
    }
  }, []);

  const exportPng = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    try {
      viewer.render();
      const uri = viewer.pngURI();
      const link = document.createElement("a");
      link.href = uri;
      link.download = `${safePngStem(filename)}.png`;
      document.body.append(link);
      link.click();
      link.remove();
      setToolNotice("PNG export started.");
    } catch (exportError) {
      setToolNotice(`PNG export failed: ${normalizeViewerError(exportError)}`);
    }
  }, [filename]);

  // Build (or rebuild) the scene whenever the file or style changes.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !format) return;

    let cancelled = false;
    setRendering(true);
    setError(null);
    setAtomCount(null);
    setAtoms([]);
    setFrameCount(1);
    setCurrentFrame(0);
    setHasFrames(false);
    setIsAnimating(false);
    setViewerVersion((version) => version + 1);
    setStructureSummary(null);
    setFallbackStructure(null);
    setFallbackNotice(null);
    setToolNotice(null);
    clearMeasurement(viewerRef.current, { shapes: measurementShapesRef, labels: measurementLabelsRef });
    clearLabels(viewerRef.current, atomLabelsRef);
    clearLabels(viewerRef.current, residueLabelsRef);
    clearSurface(surfaceViewerRef.current, surfaceIdRef);
    clearShape(isosurfaceViewerRef.current, isosurfaceShapeRef);
    surfaceViewerRef.current = null;
    isosurfaceViewerRef.current = null;
    container.replaceChildren();

    (async () => {
      let phase: RenderPhase = "prepare";
      let renderFormat = format;
      const parsedFallback = parseStructureForFallback(filename, text);
      const showFallback = (notice: string): boolean => {
        if (!parsedFallback) return false;
        setFallbackStructure(parsedFallback);
        setFallbackNotice(notice);
        setAtomCount(parsedFallback.atoms.length);
        setAtoms([]);
        setFrameCount(1);
        setCurrentFrame(0);
        setHasFrames(false);
        setStructureSummary(structureFormula(parsedFallback));
        return true;
      };
      try {
        // SMILES carries no coordinates — lay it out into a molblock first.
        let model = isSmilesFile(filename) ? await smilesToMolblock(text) : text;
        const renderAsVasp = isVaspStructureFile(filename);
        if (model && renderAsVasp) {
          phase = "parse";
          const structure = parseVaspStructure(text);
          model = vaspStructureToVasp5(structure);
          setStructureSummary(summarizeVaspStructure(structure));
          renderFormat = "vasp";
        }
        if (cancelled) return;
        if (!model) {
          setError(t("molecule.noStructuresFound"));
          return;
        }

        const hasSize = await waitForRenderableSize(container, () => cancelled);
        if (cancelled) return;
        if (!hasSize) {
          setError("3D preview cannot start because the viewer pane has no size. Resize or reopen the preview pane.");
          return;
        }

        if (!canCreateWebGlContext()) {
          if (showFallback("WebGL is unavailable; showing a local SVG structure projection.")) return;
          setError("3D structure preview requires WebGL, but this desktop webview could not create a WebGL context.");
          return;
        }

        phase = "load";
        const $3Dmol = await import("3dmol");
        if (cancelled || !containerRef.current) return;
        threeDmolRef.current = $3Dmol;

        phase = "viewer";
        const viewer = create3DmolViewer($3Dmol, containerRef.current);
        if (!viewer) throw new Error("3Dmol returned no viewer instance.");
        viewerRef.current = viewer;
        viewer.setBackgroundColor(0xffffff, 0); // transparent → our white stage shows
        applyViewOptions(viewer, { orthographic: false, viewEffect: "none" });

        phase = "parse";
        if (shouldLoadAsFrames(model, renderFormat)) viewer.addModelsAsFrames(model, renderFormat, THREE_DMOL_PARSER_OPTIONS);
        else viewer.addModel(model, renderFormat, THREE_DMOL_PARSER_OPTIONS);
        const parsedAtoms = (viewer.selectedAtoms({}) as MoleculeAtom[]).map(normalizeAtom);
        if (parsedAtoms.length === 0) {
          throw new Error(`No atoms were parsed from this file as ${renderFormat.toUpperCase()}.`);
        }
        phase = "style";
        applyStyle(viewer, defaultStyleMode(filename, text), isMacromolecule, { cartoonStyle: "default", colorMode: "jmol" });
        const replicate = replicateCounts(appliedReplicateInput);
        if (replicate && supportsUnitCellPreview(filename, renderFormat)) {
          (viewer as UnitCellViewer).replicateUnitCell?.(replicate[0], replicate[1], replicate[2], undefined, true, false);
        }
        phase = "render";
        viewer.zoomTo();
        viewer.render();
        setAtomCount(parsedAtoms.length);
        setAtoms(parsedAtoms);
        const frames = Math.max(1, viewer.getNumFrames());
        setFrameCount(frames);
        setCurrentFrame(0);
        setHasFrames(frames > 1);
        setViewerVersion((version) => version + 1);
        requestAnimationFrame(() => {
          if (!cancelled) {
            viewer.resize();
            viewer.render();
          }
        });
      } catch (e) {
        if (!cancelled) {
          viewerRef.current?.clear();
          viewerRef.current = null;
          atomPickingRegisteredRef.current = false;
          container.replaceChildren();
          setAtoms([]);
          setFrameCount(1);
          setCurrentFrame(0);
          setHasFrames(false);
          setIsAnimating(false);
          const message = formatMoleculeError(e, phase, filename, renderFormat);
          if (!showFallback(formatFallbackNotice(phase, renderFormat))) setError(message);
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();

    return () => {
      cancelled = true;
      clearMeasurement(viewerRef.current, { shapes: measurementShapesRef, labels: measurementLabelsRef });
      clearLabels(viewerRef.current, atomLabelsRef);
      clearLabels(viewerRef.current, residueLabelsRef);
      clearSurface(surfaceViewerRef.current ?? viewerRef.current, surfaceIdRef);
      clearShape(isosurfaceViewerRef.current ?? viewerRef.current, isosurfaceShapeRef);
      viewerRef.current?.clear();
      viewerRef.current = null;
      atomPickingRegisteredRef.current = false;
      surfaceViewerRef.current = null;
      isosurfaceViewerRef.current = null;
      threeDmolRef.current = null;
      container.replaceChildren();
    };
  }, [
    filename,
    format,
    isMacromolecule,
    appliedReplicateInput,
    t,
    text,
  ]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || fallbackStructure || error) return;
    applyViewOptions(viewer, { orthographic, viewEffect });
    applyStyle(viewer, styleMode, isMacromolecule, { cartoonStyle, colorMode });
    applySelectionAction(viewer, selectionSpec, selectionAction, styleMode);
    if (selectionAction === "focus" && Object.keys(selectionSpec).length > 0) viewer.zoomTo(selectionSpec);
    viewer.render();
  }, [
    cartoonStyle,
    colorMode,
    error,
    fallbackStructure,
    isMacromolecule,
    orthographic,
    selectionAction,
    selectionSpec,
    styleMode,
    viewEffect,
    viewerVersion,
  ]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !format || !supportsUnitCellPreview(filename, format)) return;
    const cellViewer = viewer as UnitCellViewer;
    cellViewer.removeUnitCell?.();
    if (showUnitCell) cellViewer.addUnitCell?.(undefined, unitCellStyle(showUnitCellLabels));
    viewer.render();
  }, [filename, format, showUnitCell, showUnitCellLabels, viewerVersion]);

  // Keep the scene sized to its container.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const v = viewerRef.current;
      if (!v) return;
      v.resize();
      v.render();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  if (!format) return <div className="p-4 text-sm text-muted">{t("molecule.notChemicalFile")}</div>;

  return (
    <div
      className={cn(
        "relative h-full min-h-[420px] w-full touch-none select-none overflow-hidden bg-white",
        fallbackStructure ? "cursor-default" : "cursor-grab",
      )}
      data-molecule-viewer="true"
    >
      <div ref={containerRef} className="absolute inset-0" aria-label={t("molecule.moleculeViewerAria", { filename })} />
      {fallbackStructure && !error && <StructureSvgFallback structure={fallbackStructure} />}

      {error && (
        <div
          className="absolute inset-x-4 bottom-14 top-16 overflow-hidden rounded-input border border-border bg-surface text-text shadow-card"
          data-molecule-fallback="true"
        >
          <div className="border-b border-border bg-surface-2 px-3 py-2 text-xs text-muted">
            {error} {t("molecule.rawTextShown")}
          </div>
          <pre className="h-[calc(100%-33px)] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-5 text-text">
            {rawTextPreview}
          </pre>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-col gap-2">
        <div
          className="pointer-events-auto flex w-fit max-w-full flex-wrap items-center gap-2 rounded-input border border-border/70 bg-surface/90 p-1 shadow-card backdrop-blur"
          data-molecule-controls="true"
        >
          <div className="flex items-center gap-1 px-1.5 text-xs font-medium text-muted">
            <Atom size={13} /> {fallbackStructure ? t("molecule.badge2D") : t("molecule.badge3D")}
          </div>
          {!fallbackStructure && (
            <>
              <div className="flex rounded bg-surface-2 p-0.5">
                {styleOptions.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setStyleMode(o.value)}
                    className={cn(
                      "rounded px-2 py-1 text-xs font-medium transition-colors",
                      styleMode === o.value ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
                    )}
                  >
                    {t(`molecule.style.${o.value}`)}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={resetView}
                aria-label={t("molecule.resetView")}
                title={t("molecule.resetView")}
                className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-text"
              >
                <RotateCcw size={13} />
              </button>
              <button
                type="button"
                onClick={() => setShowAdvancedControls((current) => !current)}
                aria-label={t("molecule.controls.advanced")}
                title={t("molecule.controls.advanced")}
                className={toolButtonClass(showAdvancedControls)}
              >
                <ScanSearch size={13} />
              </button>
              <div className="flex items-center gap-0.5 border-l border-border/70 pl-1">
                <button
                  type="button"
                  onClick={() => setShowAtomInfo((current) => !current)}
                  aria-label={t("molecule.controls.atomInfo")}
                  title={t("molecule.controls.atomInfo")}
                  className={toolButtonClass(showAtomInfo)}
                >
                  <Info size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setShowAtomLabels((current) => !current)}
                  aria-label={t("molecule.controls.elementLabels")}
                  title={t("molecule.controls.elementLabels")}
                  className={toolButtonClass(showAtomLabels)}
                >
                  <Tags size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setShowResidueLabels((current) => !current)}
                  aria-label={t("molecule.controls.residueLabels")}
                  title={t("molecule.controls.residueLabels")}
                  disabled={!isMacromolecule}
                  className={toolButtonClass(showResidueLabels, !isMacromolecule)}
                >
                  <Tags size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => toggleMeasurementMode("distance")}
                  aria-label={t("molecule.controls.measureDistance")}
                  title={t("molecule.controls.measureDistance")}
                  className={toolButtonClass(measurementMode === "distance")}
                >
                  <Ruler size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => toggleMeasurementMode("angle")}
                  aria-label={t("molecule.controls.measureAngle")}
                  title={t("molecule.controls.measureAngle")}
                  className={toolButtonClass(measurementMode === "angle")}
                >
                  <Triangle size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setShowSurface((current) => !current)}
                  aria-label={t("molecule.controls.surface")}
                  title={t("molecule.controls.surface")}
                  className={toolButtonClass(showSurface)}
                >
                  <Cloud size={13} />
                </button>
                {supportsUnitCell && (
                  <button
                    type="button"
                    onClick={() => setShowUnitCell((current) => !current)}
                    aria-label={t("molecule.controls.unitCell")}
                    title={t("molecule.controls.unitCell")}
                    className={toolButtonClass(showUnitCell)}
                  >
                    <Box size={13} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={toggleAnimation}
                  aria-label={t(isAnimating ? "molecule.controls.stopTrajectory" : "molecule.controls.playTrajectory")}
                  title={t(hasFrames ? "molecule.controls.trajectoryPlayback" : "molecule.controls.noTrajectoryFrames")}
                  disabled={!hasFrames}
                  className={toolButtonClass(isAnimating, !hasFrames)}
                >
                  {isAnimating ? <Pause size={13} /> : <Play size={13} />}
                </button>
                <button
                  type="button"
                  onClick={exportPng}
                  aria-label={t("molecule.controls.exportPng")}
                  title={t("molecule.controls.exportPng")}
                  className={toolButtonClass(false)}
                >
                  <Download size={13} />
                </button>
              </div>
            </>
          )}
        </div>

        {!fallbackStructure && !error && showAdvancedControls && (
          <div
            className="pointer-events-auto grid w-fit max-w-full gap-1 self-end rounded-input border border-border/70 bg-surface/90 p-2 text-xs text-muted shadow-card backdrop-blur sm:max-w-[390px]"
            data-molecule-controls="true"
          >
          <div className="grid grid-cols-[16px_1fr_50px_50px_50px_46px_64px] items-center gap-1">
            <ScanSearch size={13} />
            <select className={controlClass()} value={selectionPreset} onChange={(e) => setSelectionPreset(e.target.value as SelectionPreset)} aria-label={t("molecule.controls.selectionPreset")}>
              <option value="all">{t("molecule.selectionPreset.all")}</option>
              <option value="nonH">{t("molecule.selectionPreset.nonH")}</option>
              <option value="hetero">{t("molecule.selectionPreset.hetero")}</option>
              <option value="polymer">{t("molecule.selectionPreset.polymer")}</option>
            </select>
            <input className={controlClass()} value={selectionElement} onChange={(e) => setSelectionElement(e.target.value)} placeholder={t("molecule.placeholders.element")} aria-label={t("molecule.controls.selectionElement")} />
            <input className={controlClass()} value={selectionChain} onChange={(e) => setSelectionChain(e.target.value)} placeholder={t("molecule.placeholders.chain")} aria-label={t("molecule.controls.selectionChain")} />
            <input className={controlClass()} value={selectionResidue} onChange={(e) => setSelectionResidue(e.target.value)} placeholder={t("molecule.placeholders.residue")} aria-label={t("molecule.controls.selectionResidue")} />
            <input className={controlClass()} value={selectionIndex} onChange={(e) => setSelectionIndex(e.target.value)} placeholder={t("molecule.placeholders.atomIndex")} aria-label={t("molecule.controls.selectionAtomIndex")} />
            <select className={controlClass()} value={selectionAction} onChange={(e) => setSelectionAction(e.target.value as SelectionAction)} aria-label={t("molecule.controls.selectionAction")}>
              <option value="none">{t("molecule.selectionAction.none")}</option>
              <option value="highlight">{t("molecule.selectionAction.highlight")}</option>
              <option value="hide">{t("molecule.selectionAction.hide")}</option>
              <option value="focus">{t("molecule.selectionAction.focus")}</option>
            </select>
          </div>
          <div className="grid grid-cols-[16px_58px_58px_70px_32px_1fr] items-center gap-1">
            <Cloud size={13} />
            <select className={controlClass()} value={surfaceType} onChange={(e) => setSurfaceType(e.target.value as SurfaceType)} aria-label={t("molecule.controls.surfaceType")}>
              <option value="VDW">VDW</option>
              <option value="SAS">SAS</option>
              <option value="MS">MS</option>
              <option value="SES">SES</option>
            </select>
            <select className={controlClass()} value={surfaceScope} onChange={(e) => setSurfaceScope(e.target.value as SurfaceScope)} aria-label={t("molecule.controls.surfaceScope")}>
              <option value="all">{t("molecule.surfaceScope.all")}</option>
              <option value="selection">{t("molecule.surfaceScope.selection")}</option>
              <option value="hetero">{t("molecule.surfaceScope.hetero")}</option>
              <option value="polymer">{t("molecule.surfaceScope.polymer")}</option>
            </select>
            <select className={controlClass()} value={surfaceColorMode} onChange={(e) => setSurfaceColorMode(e.target.value as SurfaceColorMode)} aria-label={t("molecule.controls.surfaceColorMode")}>
              <option value="solid">{t("molecule.surfaceColorMode.solid")}</option>
              <option value="element">{t("molecule.surfaceColorMode.element")}</option>
              <option value="charge">{t("molecule.surfaceColorMode.charge")}</option>
              <option value="cube">{t("molecule.surfaceColorMode.cube")}</option>
            </select>
            <input className="h-6 w-8 rounded border border-border bg-surface" type="color" value={surfaceColor} onChange={(e) => setSurfaceColor(e.target.value)} aria-label={t("molecule.controls.surfaceColor")} />
            <input type="range" min="0.1" max="1" step="0.05" value={surfaceOpacity} onChange={(e) => setSurfaceOpacity(Number(e.target.value))} aria-label={t("molecule.controls.surfaceOpacity")} />
          </div>
          <div className="grid grid-cols-[16px_72px_72px_86px_28px] items-center gap-1">
            <Palette size={13} />
            <select className={controlClass()} value={colorMode} onChange={(e) => setColorMode(e.target.value)} aria-label={t("molecule.controls.colorMode")}>
              <option value="jmol">{t("molecule.colorMode.jmol")}</option>
              <option value="chain">{t("molecule.colorMode.chain")}</option>
              <option value="spectrum">{t("molecule.colorMode.spectrum")}</option>
              <option value="x">{t("molecule.colorMode.xGradient")}</option>
            </select>
            <select className={controlClass()} value={cartoonStyle} onChange={(e) => setCartoonStyle(e.target.value as CartoonStyle)} aria-label={t("molecule.controls.cartoonStyle")} disabled={styleMode !== "cartoon"}>
              <option value="default">{t("molecule.cartoonStyle.default")}</option>
              <option value="trace">{t("molecule.cartoonStyle.trace")}</option>
              <option value="tube">{t("molecule.cartoonStyle.tube")}</option>
              <option value="arrow">{t("molecule.cartoonStyle.arrow")}</option>
            </select>
            <select className={controlClass()} value={viewEffect} onChange={(e) => setViewEffect(e.target.value as ViewEffect)} aria-label={t("molecule.controls.viewEffect")}>
              <option value="none">{t("molecule.viewEffect.none")}</option>
              <option value="outline">{t("molecule.viewEffect.outline")}</option>
              <option value="ambientOcclusion">AO</option>
            </select>
            <button type="button" className={toolButtonClass(orthographic)} onClick={() => setOrthographic((v) => !v)} aria-label={t("molecule.controls.orthographic")} title={t("molecule.controls.orthographic")}>
              <Aperture size={13} />
            </button>
          </div>
          {format === "cube" && (
            <div className="grid grid-cols-[16px_28px_70px_32px_1fr] items-center gap-1">
              <Layers size={13} />
              <button type="button" className={toolButtonClass(showIsosurface)} onClick={() => setShowIsosurface((v) => !v)} aria-label={t("molecule.controls.cubeIsosurface")} title={t("molecule.controls.cubeIsosurface")}>
                <Cloud size={13} />
              </button>
              <input className={controlClass()} type="number" step="0.005" value={isosurfaceValue} onChange={(e) => setIsosurfaceValue(Number(e.target.value))} aria-label={t("molecule.controls.isosurfaceValue")} />
              <input className="h-6 w-8 rounded border border-border bg-surface" type="color" value={isosurfaceColor} onChange={(e) => setIsosurfaceColor(e.target.value)} aria-label={t("molecule.controls.isosurfaceColor")} />
              <input type="range" min="0.1" max="1" step="0.05" value={isosurfaceOpacity} onChange={(e) => setIsosurfaceOpacity(Number(e.target.value))} aria-label={t("molecule.controls.isosurfaceOpacity")} />
            </div>
          )}
          <div className="grid grid-cols-[16px_28px_1fr_28px_54px_72px_28px_28px] items-center gap-1">
            <Film size={13} />
            <button type="button" className={toolButtonClass(false, frameCount <= 1)} disabled={frameCount <= 1} onClick={() => stepFrame(-1)} aria-label={t("molecule.controls.previousFrame")}>
              <ChevronLeft size={13} />
            </button>
            <input type="range" min="0" max={Math.max(0, frameCount - 1)} step="1" value={currentFrame} disabled={frameCount <= 1} onChange={(e) => goToFrame(Number(e.target.value))} aria-label={t("molecule.controls.trajectoryFrame")} />
            <button type="button" className={toolButtonClass(false, frameCount <= 1)} disabled={frameCount <= 1} onClick={() => stepFrame(1)} aria-label={t("molecule.controls.nextFrame")}>
              <ChevronRight size={13} />
            </button>
            <input className={controlClass()} type="number" min="30" max="1000" step="10" value={trajectorySpeed} onChange={(e) => setTrajectorySpeed(Number(e.target.value))} aria-label={t("molecule.controls.trajectorySpeed")} />
            <select className={controlClass()} value={trajectoryLoop} onChange={(e) => setTrajectoryLoop(e.target.value as TrajectoryLoop)} aria-label={t("molecule.controls.trajectoryLoop")}>
              <option value="forward">{t("molecule.trajectoryLoop.forward")}</option>
              <option value="backAndForth">{t("molecule.trajectoryLoop.backAndForth")}</option>
            </select>
            <button type="button" className={toolButtonClass(false, frameCount <= 1)} disabled={frameCount <= 1} onClick={exportApng} aria-label={t("molecule.controls.exportApng")} title={t("molecule.controls.exportApng")}>
              <Image size={13} />
            </button>
            <button type="button" className={toolButtonClass(false)} onClick={addVibrationFrames} aria-label={t("molecule.controls.vibrationFrames")} title={t("molecule.controls.vibrationFrames")}>
              <Zap size={13} />
            </button>
          </div>
          {supportsUnitCell && (
            <div className="grid grid-cols-[16px_96px_28px_28px] items-center gap-1">
              <Grid3X3 size={13} />
              <input
                className={controlClass()}
                value={replicateInput}
                onBlur={applyReplicateInput}
                onChange={(e) => setReplicateInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  applyReplicateInput();
                  e.currentTarget.blur();
                }}
                placeholder={DEFAULT_REPLICATE_INPUT}
                aria-label={t("molecule.controls.replicateUnitCell")}
                title={t("molecule.controls.replicateHint")}
                spellCheck={false}
              />
              <button type="button" className={toolButtonClass(showUnitCellLabels)} onClick={() => setShowUnitCellLabels((v) => !v)} aria-label={t("molecule.controls.unitCellAxisLabels")} title={t("molecule.controls.unitCellAxisLabels")}>
                <Layers size={13} />
              </button>
              <button type="button" className={toolButtonClass(replicateCounts(appliedReplicateInput) !== null)} onClick={resetReplication} aria-label={t("molecule.controls.resetReplication")} title={t("molecule.controls.resetReplication")}>
                <Repeat size={13} />
              </button>
            </div>
          )}
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute bottom-3 right-3 max-w-[46%] truncate rounded-input border border-border/70 bg-surface/90 px-3 py-1.5 text-xs text-muted shadow-card backdrop-blur">
        <span className="font-medium text-text">{format.toUpperCase()}</span>
        {atomCount !== null && <span className="ml-2">{t("molecule.atomCount", { count: atomCount })}</span>}
        {structureSummary && <span className="ml-2">{structureSummary}</span>}
      </div>

      {(rendering || (fallbackNotice && !error) || (showAtomInfo && selectedAtom && !fallbackStructure) || measurementText || toolNotice) && (
        <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[46%] flex-col gap-2">
          {rendering && (
            <div className="rounded-input border border-border/70 bg-surface/95 px-3 py-1.5 text-xs text-muted shadow-card backdrop-blur">
              {t("molecule.renderingStructure")}
            </div>
          )}
          {!rendering && fallbackNotice && !error && (
            <div className="rounded-input border border-border/70 bg-surface/95 px-3 py-1.5 text-xs text-muted shadow-card backdrop-blur">
              {fallbackNotice}
            </div>
          )}
          {showAtomInfo && selectedAtom && !fallbackStructure && (
            <div className="rounded-input border border-border/70 bg-surface/95 px-3 py-2 text-xs text-muted shadow-card backdrop-blur">
              <div className="flex items-center gap-1.5 font-medium text-text">
                <Info size={13} />
                {atomTitle(selectedAtom)}
              </div>
              {atomResidueText(selectedAtom) && <div className="mt-1">{atomResidueText(selectedAtom)}</div>}
              <div className="mt-1 font-mono">{atomCoordinateText(selectedAtom)}</div>
            </div>
          )}
          {measurementText && (
            <div className="rounded-input border border-border/70 bg-surface/95 px-3 py-1.5 text-xs text-muted shadow-card backdrop-blur">
              {measurementText}
            </div>
          )}
          {toolNotice && (
            <div className="rounded-input border border-border/70 bg-surface/95 px-3 py-1.5 text-xs text-muted shadow-card backdrop-blur">
              {toolNotice}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Apply a render style, mirroring 3Dmol's Jmol color scheme conventions. */
function applyStyle(
  viewer: GLViewer,
  mode: MoleculeStyleMode,
  isMacromolecule: boolean,
  options: { cartoonStyle: CartoonStyle; colorMode: string },
) {
  const colorscheme = colorScheme(options.colorMode);
  if (mode === "sphere") {
    viewer.setStyle({}, { sphere: { colorscheme, scale: 0.36 } });
    return;
  }
  if (mode === "line") {
    viewer.setStyle({}, { line: { colorscheme } });
    return;
  }
  if (mode === "cross") {
    viewer.setStyle({}, { cross: { colorscheme, radius: 0.34 } });
    return;
  }
  // Cartoon needs a residue backbone; on a small molecule 3Dmol dereferences a
  // missing atom.resn and throws, so only draw it for macromolecules.
  if (mode === "cartoon" && isMacromolecule) {
    viewer.setStyle({}, { cartoon: cartoonSpec(options.cartoonStyle, options.colorMode) });
    // Ligands/hetero atoms have no secondary structure — show them as sticks.
    viewer.setStyle({ hetflag: true }, { stick: { colorscheme, radius: 0.12 } });
    return;
  }
  viewer.setStyle({}, { stick: { colorscheme, radius: 0.18 }, sphere: { colorscheme, scale: 0.26 } });
}

function controlClass(): string {
  return "h-6 min-w-0 rounded border border-border bg-surface px-1 text-[11px] text-text outline-none";
}

function toolButtonClass(active: boolean, disabled = false): string {
  return cn(
    "flex h-7 w-7 items-center justify-center rounded transition-colors",
    disabled
      ? "cursor-not-allowed text-muted/35"
      : active
        ? "bg-surface text-text shadow-sm"
        : "text-muted hover:bg-surface-2 hover:text-text",
  );
}

function colorScheme(mode: string): ColorschemeSpec {
  if (mode === "chain") return "chain";
  if (mode === "spectrum") return "spectrum";
  if (mode === "x") return { prop: "x", gradient: "roygb" };
  return "Jmol";
}

function cartoonSpec(style: CartoonStyle, colorMode: string): CartoonStyleSpec {
  const color = colorMode === "spectrum" ? ("spectrum" as const) : undefined;
  const colorscheme = color ? undefined : colorScheme(colorMode);
  if (style === "trace") return { style: "trace", color, colorscheme };
  if (style === "tube") return { tubes: true, color, colorscheme };
  if (style === "arrow") return { arrows: true, color, colorscheme };
  return { color, colorscheme };
}

function supportsUnitCellPreview(filename: string, format: string | null): boolean {
  return isVaspStructureFile(filename) || format === "vasp" || format === "cif";
}

function buildSelectionSpec(filters: {
  preset: SelectionPreset;
  element: string;
  chain: string;
  residue: string;
  index: string;
}): Record<string, unknown> {
  const spec: Record<string, unknown> = {};
  if (filters.preset === "nonH") spec.not = { elem: "H" };
  if (filters.preset === "hetero") spec.hetflag = true;
  if (filters.preset === "polymer") spec.hetflag = false;
  const elem = normalizeElement(filters.element);
  if (elem) spec.elem = elem;
  const chain = filters.chain.trim();
  if (chain) spec.chain = chain;
  const residue = filters.residue.trim();
  if (residue) {
    const residueNumber = Number.parseInt(residue, 10);
    if (Number.isFinite(residueNumber)) spec.resi = residueNumber;
    else spec.resn = residue.toUpperCase();
  }
  const index = Number.parseInt(filters.index.trim(), 10);
  if (Number.isFinite(index)) {
    spec.index = Math.max(0, index - 1);
  }
  return spec;
}

function surfaceSelection(scope: SurfaceScope, selectionSpec: Record<string, unknown>): Record<string, unknown> {
  if (scope === "selection") return selectionSpec;
  if (scope === "hetero") return { hetflag: true };
  if (scope === "polymer") return { hetflag: false };
  return {};
}

function applySelectionAction(
  viewer: GLViewer,
  selectionSpec: Record<string, unknown>,
  action: SelectionAction,
  mode: MoleculeStyleMode,
) {
  if (action === "none" || Object.keys(selectionSpec).length === 0) return;
  if (action === "focus") {
    viewer.zoomTo(selectionSpec);
    return;
  }
  if (action === "hide") {
    viewer.setStyle(selectionSpec, {
      cartoon: { hidden: true },
      cross: { hidden: true },
      line: { hidden: true },
      sphere: { hidden: true },
      stick: { hidden: true },
    });
    return;
  }
  if (mode === "line") {
    viewer.setStyle(selectionSpec, { line: { color: "#f59e0b" } });
    return;
  }
  if (mode === "cross") {
    viewer.setStyle(selectionSpec, { cross: { color: "#f59e0b", radius: 0.4 } });
    return;
  }
  const highlight =
    mode === "sphere"
      ? { sphere: { color: "#f59e0b", scale: 0.52 } }
      : { stick: { color: "#f59e0b", radius: 0.28 }, sphere: { color: "#fbbf24", scale: 0.34 } };
  viewer.setStyle(selectionSpec, highlight);
}

function applyViewOptions(viewer: GLViewer, options: { orthographic: boolean; viewEffect: ViewEffect }) {
  viewer.setProjection(options.orthographic ? "orthographic" : "perspective");
  if (options.viewEffect === "outline") {
    viewer.setViewStyle({ style: "outline", color: "#111827", width: 0.05 });
  } else if (options.viewEffect === "ambientOcclusion") {
    viewer.setViewStyle({ style: "ambientOcclusion", strength: 0.75, radius: 5 });
  } else {
    viewer.setViewStyle({ style: "none" });
  }
}

function buildSurfaceStyle(options: {
  color: string;
  colorMode: SurfaceColorMode;
  format: string | null;
  module: ThreeDmolModule | null;
  opacity: number;
  text: string;
  viewer: GLViewer;
}): SurfaceStyleSpec {
  const style: SurfaceStyleSpec = { opacity: options.opacity };
  if (options.colorMode === "element") {
    style.colorscheme = "Jmol";
    return style;
  }
  if (options.colorMode === "charge") {
    const module = options.module as unknown as { applyPartialCharges?: unknown; Gradient?: { RWB?: new (min: number, max: number) => unknown } } | null;
    const mapper = module?.applyPartialCharges;
    if (mapper) (options.viewer as EnhancedViewer).mapAtomProperties?.(mapper, {});
    style.map = { prop: "partialCharge", scheme: module?.Gradient?.RWB ? new module.Gradient.RWB(-0.05, 0.05) : { gradient: "rwb", min: -0.05, max: 0.05 } };
    return style;
  }
  if (options.colorMode === "cube" && options.format === "cube") {
    const module = options.module as unknown as {
      Gradient?: { RWB?: new (min: number, max: number) => unknown };
    } | null;
    style.voldata = cubeVolumeData(options.module, options.text) as SurfaceStyleSpec["voldata"];
    style.volformat = options.module && "VolumeData" in options.module ? undefined : "cube";
    style.volscheme = (
      module?.Gradient?.RWB ? new module.Gradient.RWB(-10, 10) : { gradient: "rwb", min: -10, max: 10 }
    ) as SurfaceStyleSpec["volscheme"];
    return style;
  }
  style.color = options.color;
  return style;
}

function cubeVolumeData(module: ThreeDmolModule | null, text: string): unknown {
  const volumeModule = module as unknown as { VolumeData?: new (text: string, format: string) => unknown } | null;
  return volumeModule?.VolumeData ? new volumeModule.VolumeData(text, "cube") : text;
}

function replicateCounts(input: string): [number, number, number] | null {
  return parseReplicateInput(input)?.counts ?? null;
}

function parseReplicateInput(input: string): { counts: [number, number, number]; label: string } | null {
  const trimmed = input.trim().toLowerCase().replace(/[×*]/g, "x");
  if (!trimmed) return null;
  const parts = trimmed.split(/[x,\s]+/).filter(Boolean);
  if (parts.length !== 1 && parts.length !== 3) return null;

  const values = parts.map((part) => Number(part));
  if (values.some((value) => !Number.isInteger(value) || value < 1 || value > MAX_REPLICATE_AXIS)) return null;

  const counts = (values.length === 1 ? [values[0], values[0], values[0]] : values) as [number, number, number];
  const totalCells = counts[0] * counts[1] * counts[2];
  if (totalCells > MAX_REPLICATE_CELLS) return null;

  return {
    counts,
    label: `${counts[0]}x${counts[1]}x${counts[2]}`,
  };
}

function unitCellStyle(showLabels: boolean): Record<string, unknown> {
  if (!showLabels) return { box: { color: "#7f8794" } };
  const labelStyle = {
    backgroundColor: "#ffffff",
    backgroundOpacity: 0.8,
    fontColor: "#111827",
    fontSize: 18,
    inFront: true,
  };
  return {
    alabel: "a",
    alabelstyle: labelStyle,
    astyle: { color: "#ef4444", radius: 0.12 },
    blabel: "b",
    blabelstyle: labelStyle,
    bstyle: { color: "#16a34a", radius: 0.12 },
    box: { color: "#7f8794" },
    clabel: "c",
    clabelstyle: labelStyle,
    cstyle: { color: "#2563eb", radius: 0.12 },
  };
}

function normalizeAtom(atom: MoleculeAtom): MoleculeAtom {
  return {
    atom: atom.atom,
    chain: atom.chain,
    elem: normalizeElement(atom.elem) ?? normalizeElement(atom.atom),
    index: atom.index,
    resi: atom.resi,
    resn: atom.resn,
    serial: atom.serial,
    x: numberOrUndefined(atom.x),
    y: numberOrUndefined(atom.y),
    z: numberOrUndefined(atom.z),
  };
}

function normalizeElement(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const letters = value.trim().replace(/[^a-zA-Z]/g, "");
  if (!letters) return undefined;
  if (letters.length === 1) return letters.toUpperCase();
  return `${letters[0].toUpperCase()}${letters[1].toLowerCase()}`;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function atomTitle(atom: MoleculeAtom): string {
  const name = atom.atom || atom.elem || "Atom";
  const serial = atom.serial ?? atom.index;
  return serial === undefined ? name : `${name} #${serial}`;
}

function atomLabel(atom: MoleculeAtom): string {
  const base = atom.elem || atom.atom || "?";
  return atom.index === undefined ? base : `${base}${atom.index + 1}`;
}

function atomResidueText(atom: MoleculeAtom): string | null {
  const parts = [atom.resn, atom.resi === undefined ? null : String(atom.resi), atom.chain ? `chain ${atom.chain}` : null].filter(
    Boolean,
  );
  return parts.length === 0 ? null : parts.join(" · ");
}

function atomCoordinateText(atom: MoleculeAtom): string {
  if (!hasCoordinates(atom)) return "coordinates unavailable";
  return `x=${atom.x.toFixed(3)} y=${atom.y.toFixed(3)} z=${atom.z.toFixed(3)}`;
}

function syncLabels(
  viewer: GLViewer,
  atoms: MoleculeAtom[],
  options: {
    atomLabelsRef: MutableRefObject<unknown[]>;
    residueLabelsRef: MutableRefObject<unknown[]>;
    showAtomLabels: boolean;
    showResidueLabels: boolean;
    isMacromolecule: boolean;
    setToolNotice: (notice: string | null) => void;
  },
) {
  clearLabels(viewer, options.atomLabelsRef);
  clearLabels(viewer, options.residueLabelsRef);

  if (options.showAtomLabels) {
    if (atoms.length > ATOM_LABEL_LIMIT) {
      options.setToolNotice(`Element labels skipped: ${atoms.length} atoms is above the local label limit.`);
    } else {
      options.atomLabelsRef.current = atoms
        .filter(hasCoordinates)
        .map((atom) =>
          viewer.addLabel(atomLabel(atom), {
            position: atom,
            fontColor: "#111827",
            fontSize: 11,
            backgroundColor: "#ffffff",
            backgroundOpacity: 0.78,
            borderColor: "#cbd5e1",
            borderThickness: 0.5,
            inFront: true,
          }),
        );
    }
  }

  if (options.showResidueLabels) {
    if (!options.isMacromolecule) {
      options.setToolNotice("Residue labels are available for macromolecular structures.");
    } else if (atoms.length > RESIDUE_LABEL_LIMIT) {
      options.setToolNotice(`Residue labels skipped: ${atoms.length} atoms is above the local label limit.`);
    } else {
      options.residueLabelsRef.current = viewer.addResLabels(
        { hetflag: false },
        {
          fontColor: "#111827",
          fontSize: 12,
          backgroundColor: "#ffffff",
          backgroundOpacity: 0.72,
          borderColor: "#cbd5e1",
          borderThickness: 0.5,
          inFront: true,
        },
      );
    }
  }

  viewer.render();
}

function clearLabels(viewer: GLViewer | null, ref: MutableRefObject<unknown[]>) {
  if (!viewer) {
    ref.current = [];
    return;
  }
  for (const label of ref.current) {
    try {
      viewer.removeLabel(label as never);
    } catch {
      // 3Dmol labels are viewer-local; clearing a destroyed viewer is harmless.
    }
  }
  ref.current = [];
}

function renderMeasurement(viewer: GLViewer, mode: MeasurementMode, atoms: MoleculeAtom[], refs: MeasurementRefs) {
  clearMeasurement(viewer, refs);
  if (mode === "distance") {
    if (atoms.length < 2 || !hasCoordinates(atoms[0]) || !hasCoordinates(atoms[1])) return;
    refs.shapes.current.push(
      viewer.addLine({
        start: atoms[0],
        end: atoms[1],
        color: "#334155",
        dashed: true,
      }),
    );
    refs.labels.current.push(viewer.addLabel(`${atomDistance(atoms[0], atoms[1]).toFixed(2)} A`, measurementLabelSpec(midpoint(atoms[0], atoms[1]))));
    viewer.render();
    return;
  }
  if (mode === "angle") {
    if (atoms.length < 3 || !hasCoordinates(atoms[0]) || !hasCoordinates(atoms[1]) || !hasCoordinates(atoms[2])) return;
    refs.shapes.current.push(viewer.addLine({ start: atoms[1], end: atoms[0], color: "#334155", dashed: true }));
    refs.shapes.current.push(viewer.addLine({ start: atoms[1], end: atoms[2], color: "#334155", dashed: true }));
    refs.labels.current.push(
      viewer.addLabel(`${atomAngle(atoms[0], atoms[1], atoms[2]).toFixed(1)} deg`, measurementLabelSpec(coordinatePoint(atoms[1]))),
    );
    viewer.render();
  }
}

function clearMeasurement(viewer: GLViewer | null, refs: MeasurementRefs) {
  if (!viewer) {
    refs.shapes.current = [];
    refs.labels.current = [];
    return;
  }
  for (const shape of refs.shapes.current) {
    try {
      viewer.removeShape(shape as never);
    } catch {
      // 3Dmol shapes are viewer-local; clearing a destroyed viewer is harmless.
    }
  }
  for (const label of refs.labels.current) {
    try {
      viewer.removeLabel(label as never);
    } catch {
      // 3Dmol labels are viewer-local; clearing a destroyed viewer is harmless.
    }
  }
  refs.shapes.current = [];
  refs.labels.current = [];
}

function formatMeasurement(mode: MeasurementMode, atoms: MoleculeAtom[]): string | null {
  if (mode === "none") return null;
  if (mode === "distance") {
    if (atoms.length < 2) return `Distance: select 2 atoms (${atoms.length}/2).`;
    if (!hasCoordinates(atoms[0]) || !hasCoordinates(atoms[1])) return "Distance: selected atom coordinates unavailable.";
    return `Distance ${atomLabel(atoms[0])}-${atomLabel(atoms[1])}: ${atomDistance(atoms[0], atoms[1]).toFixed(2)} A`;
  }
  if (atoms.length < 3) return `Angle: select 3 atoms (${atoms.length}/3).`;
  if (!hasCoordinates(atoms[0]) || !hasCoordinates(atoms[1]) || !hasCoordinates(atoms[2])) {
    return "Angle: selected atom coordinates unavailable.";
  }
  return `Angle ${atomLabel(atoms[0])}-${atomLabel(atoms[1])}-${atomLabel(atoms[2])}: ${atomAngle(atoms[0], atoms[1], atoms[2]).toFixed(1)} deg`;
}

function measurementLabelSpec(position: { x: number; y: number; z: number }) {
  return {
    position,
    fontColor: "#111827",
    fontSize: 12,
    backgroundColor: "#ffffff",
    backgroundOpacity: 0.85,
    borderColor: "#64748b",
    borderThickness: 0.8,
    inFront: true,
  };
}

function coordinatePoint(atom: MoleculeAtom & { x: number; y: number; z: number }) {
  return { x: atom.x, y: atom.y, z: atom.z };
}

function hasCoordinates(atom: MoleculeAtom): atom is MoleculeAtom & { x: number; y: number; z: number } {
  return atom.x !== undefined && atom.y !== undefined && atom.z !== undefined;
}

function atomDistance(a: MoleculeAtom & { x: number; y: number; z: number }, b: MoleculeAtom & { x: number; y: number; z: number }) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function atomAngle(
  a: MoleculeAtom & { x: number; y: number; z: number },
  b: MoleculeAtom & { x: number; y: number; z: number },
  c: MoleculeAtom & { x: number; y: number; z: number },
) {
  const ab = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  const cb = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
  const dot = ab.x * cb.x + ab.y * cb.y + ab.z * cb.z;
  const abLen = Math.sqrt(ab.x * ab.x + ab.y * ab.y + ab.z * ab.z);
  const cbLen = Math.sqrt(cb.x * cb.x + cb.y * cb.y + cb.z * cb.z);
  if (abLen === 0 || cbLen === 0) return 0;
  const cosine = Math.max(-1, Math.min(1, dot / (abLen * cbLen)));
  return (Math.acos(cosine) * 180) / Math.PI;
}

function midpoint(a: MoleculeAtom & { x: number; y: number; z: number }, b: MoleculeAtom & { x: number; y: number; z: number }) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

function clearSurface(viewer: GLViewer | null, surfaceIdRef: MutableRefObject<number | null>) {
  const surfaceId = surfaceIdRef.current;
  if (viewer && surfaceId !== null) {
    try {
      viewer.removeSurface(surfaceId);
      viewer.render();
    } catch {
      // Async surface creation can finish after a viewer has been replaced.
    }
  }
  surfaceIdRef.current = null;
}

function clearShape(viewer: GLViewer | null, shapeRef: MutableRefObject<unknown | null>) {
  const shape = shapeRef.current;
  if (viewer && shape) {
    try {
      viewer.removeShape(shape as never);
      viewer.render();
    } catch {
      // Shape removal can race with viewer replacement during file switches.
    }
  }
  shapeRef.current = null;
}

function surfaceIdFrom(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = surfaceIdFrom(item);
      if (id !== null) return id;
    }
  }
  if (value && typeof value === "object") {
    const surfid = (value as { surfid?: unknown }).surfid;
    if (typeof surfid === "number" && Number.isFinite(surfid)) return surfid;
  }
  return null;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && typeof value === "object" && typeof (value as { then?: unknown }).then === "function");
}

function shouldLoadAsFrames(model: string, format: string): boolean {
  return format === "xyz" && looksLikeMultiFrameXyz(model);
}

function looksLikeMultiFrameXyz(model: string): boolean {
  const lines = model.split(/\r?\n/);
  let cursor = 0;
  let frames = 0;
  while (cursor < lines.length) {
    while (cursor < lines.length && lines[cursor].trim() === "") cursor += 1;
    if (cursor >= lines.length) break;
    const atomCount = Number.parseInt(lines[cursor].trim(), 10);
    if (!Number.isFinite(atomCount) || atomCount < 1) return false;
    cursor += atomCount + 2;
    if (cursor > lines.length + 1) return false;
    frames += 1;
  }
  return frames > 1;
}

function safePngStem(filename: string): string {
  const base = filename.split(/[\\/]/).pop() || "structure";
  const withoutExtension = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  return withoutExtension.replace(/[^a-zA-Z0-9._-]+/g, "_") || "structure";
}

function StructureSvgFallback({ structure }: { structure: SimpleStructure }) {
  const drawing = useMemo(() => projectStructure(structure.atoms), [structure]);
  const showLabels = drawing.atoms.length <= 80;

  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 1000 700"
      role="img"
      aria-label={`${structure.title} SVG structure preview`}
      data-testid="structure-fallback-svg"
    >
      <rect width="1000" height="700" fill="#ffffff" />
      <g opacity="0.72">
        {drawing.bonds.map((bond) => {
          const a = drawing.atoms[bond[0]];
          const b = drawing.atoms[bond[1]];
          return (
            <line
              key={`${bond[0]}-${bond[1]}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="#9aa0a6"
              strokeWidth="4"
              strokeLinecap="round"
            />
          );
        })}
      </g>
      <g>
        {drawing.atoms
          .slice()
          .sort((a, b) => a.depth - b.depth)
          .map((atom) => (
            <g key={atom.index}>
              <circle cx={atom.x + 3} cy={atom.y + 4} r={atom.r} fill="#000000" opacity="0.12" />
              <circle
                cx={atom.x}
                cy={atom.y}
                r={atom.r}
                fill={elementColor(atom.atom.element)}
                stroke="#1f2937"
                strokeWidth="1.5"
              />
              {showLabels && (
                <text
                  x={atom.x}
                  y={atom.y + 3.5}
                  textAnchor="middle"
                  fontFamily="Inter, system-ui, sans-serif"
                  fontSize="11"
                  fontWeight="700"
                  fill={labelColor(atom.atom.element)}
                  pointerEvents="none"
                >
                  {atom.atom.element}
                </text>
              )}
            </g>
          ))}
      </g>
    </svg>
  );
}

function projectStructure(atoms: SimpleStructureAtom[]) {
  const raw = atoms.map((atom, index) => ({
    atom,
    index,
    px: atom.x - atom.z * 0.28,
    py: atom.y + atom.z * 0.16,
    depth: atom.z,
  }));
  const minX = Math.min(...raw.map((atom) => atom.px));
  const maxX = Math.max(...raw.map((atom) => atom.px));
  const minY = Math.min(...raw.map((atom) => atom.py));
  const maxY = Math.max(...raw.map((atom) => atom.py));
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const padding = 80;
  const scale = Math.min((1000 - padding * 2) / spanX, (700 - padding * 2) / spanY);
  const xOffset = (1000 - spanX * scale) / 2;
  const yOffset = (700 - spanY * scale) / 2;
  const projected = raw.map((atom) => ({
    ...atom,
    x: xOffset + (atom.px - minX) * scale,
    y: 700 - (yOffset + (atom.py - minY) * scale),
    r: atomRadius(atom.atom.element),
  }));

  return {
    atoms: projected,
    bonds: inferBonds(atoms),
  };
}

function inferBonds(atoms: SimpleStructureAtom[]): Array<[number, number]> {
  if (atoms.length > 450) return [];
  const bonds: Array<[number, number]> = [];
  for (let i = 0; i < atoms.length; i += 1) {
    for (let j = i + 1; j < atoms.length; j += 1) {
      const d = distance(atoms[i], atoms[j]);
      const max = (covalentRadius(atoms[i].element) + covalentRadius(atoms[j].element)) * 1.28;
      if (d > 0.25 && d <= max) bonds.push([i, j]);
    }
  }
  return bonds;
}

function distance(a: SimpleStructureAtom, b: SimpleStructureAtom): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function covalentRadius(element: string): number {
  const radii: Record<string, number> = {
    H: 0.31,
    C: 0.76,
    N: 0.71,
    O: 0.66,
    F: 0.57,
    P: 1.07,
    S: 1.05,
    Cl: 1.02,
    Br: 1.2,
    I: 1.39,
    Si: 1.11,
    Fe: 1.24,
    Zn: 1.22,
  };
  return radii[element] ?? 0.77;
}

function atomRadius(element: string): number {
  return Math.max(8, Math.min(18, covalentRadius(element) * 12.5));
}

function elementColor(element: string): string {
  const colors: Record<string, string> = {
    H: "#f8fafc",
    C: "#6b7280",
    N: "#2563eb",
    O: "#dc2626",
    F: "#16a34a",
    P: "#f97316",
    S: "#eab308",
    Cl: "#22c55e",
    Br: "#92400e",
    I: "#7e22ce",
    Si: "#d97706",
    Fe: "#b45309",
    Zn: "#64748b",
  };
  return colors[element] ?? "#14b8a6";
}

function labelColor(element: string): string {
  return ["H", "S", "Si"].includes(element) ? "#111827" : "#ffffff";
}

function canCreateWebGlContext(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") ||
        canvas.getContext("webgl") ||
        canvas.getContext("experimental-webgl"),
    );
  } catch {
    return false;
  }
}

function create3DmolViewer($3Dmol: ThreeDmolModule, container: HTMLElement): GLViewer | null {
  return with3DmolCanvasCompatibility(() => $3Dmol.createViewer(container, { backgroundColor: "white" }));
}

function with3DmolCanvasCompatibility<T>(createViewer: () => T): T {
  if (!shouldBypass3DmolOffscreenCanvas()) return createViewer();

  const globalScope = globalThis as unknown as OffscreenCanvasGlobal;
  const originalOffscreenCanvas = globalScope.OffscreenCanvas;
  globalScope.OffscreenCanvas = undefined;
  try {
    return createViewer();
  } finally {
    globalScope.OffscreenCanvas = originalOffscreenCanvas;
  }
}

function shouldBypass3DmolOffscreenCanvas(): boolean {
  if (typeof OffscreenCanvas === "undefined") return false;
  if (!canCreateWebGlContext()) return false;
  if (offscreenCanvasHasWebGl === null) offscreenCanvasHasWebGl = canCreateOffscreenWebGlContext();
  return !offscreenCanvasHasWebGl;
}

function canCreateOffscreenWebGlContext(): boolean {
  try {
    const canvas = new OffscreenCanvas(16, 16);
    const attributes: WebGLContextAttributes = {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      preserveDrawingBuffer: false,
    };
    return Boolean(canvas.getContext("webgl2", attributes) || canvas.getContext("webgl", attributes));
  } catch {
    return false;
  }
}

async function waitForRenderableSize(container: HTMLElement, isCancelled: () => boolean): Promise<boolean> {
  for (let i = 0; i <= SIZE_WAIT_FRAMES; i += 1) {
    if (hasRenderableSize(container)) return true;
    if (i < SIZE_WAIT_FRAMES) await nextFrame();
    if (isCancelled()) return false;
  }
  return false;
}

function hasRenderableSize(container: HTMLElement): boolean {
  const rect = container.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

function formatMoleculeError(error: unknown, phase: RenderPhase, filename: string, format: string): string {
  const detail = normalizeViewerError(error);
  const label = format.toUpperCase();
  if (phase === "load") return `Could not load the 3D molecule viewer: ${detail}`;
  if (phase === "viewer") return `3D viewer could not start for ${filename}. Check WebGL and preview pane size. Details: ${detail}`;
  if (phase === "parse") {
    if (/^No atoms were parsed/i.test(detail)) return detail;
    return `Could not parse ${filename} as ${label}: ${detail}`;
  }
  return `Could not render ${filename} as ${label}: ${detail}`;
}

function formatFallbackNotice(phase: RenderPhase, format: string): string {
  const label = format.toUpperCase();
  if (phase === "parse") {
    return `3D ${label} preview could not parse atoms here; showing a local 2D structure projection.`;
  }
  return "3D WebGL preview is unavailable here; showing a local 2D structure projection.";
}

function normalizeViewerError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message || error.name
      : typeof error === "string"
        ? error
        : String(error);
  const clean = raw.replace(/^error creating viewer:\s*/i, "").trim();
  if (!clean || clean === "[object Object]") return "unknown viewer error";
  if (/^TypeError$/i.test(clean)) return "the viewer raised a generic TypeError during initialization";
  return clean;
}
