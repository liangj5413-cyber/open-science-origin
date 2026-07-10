import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoleculeView } from "./MoleculeView";

// 3Dmol needs WebGL, which jsdom lacks — mock it and assert the wiring
// (model handed over with the right format, styles applied on toggle).
const DEFAULT_ATOMS = [
  { atom: "C1", elem: "C", index: 0, serial: 1, resn: "LIG", resi: 1, chain: "A", x: 0, y: 0, z: 0 },
  { atom: "O1", elem: "O", index: 1, serial: 2, resn: "LIG", resi: 1, chain: "A", x: 1.2, y: 0, z: 0 },
  { atom: "N1", elem: "N", index: 2, serial: 3, resn: "LIG", resi: 1, chain: "A", x: 1.2, y: 1.2, z: 0 },
];

const viewer = {
  setBackgroundColor: vi.fn(),
  setProjection: vi.fn(),
  setViewStyle: vi.fn(),
  addModel: vi.fn(),
  addModelsAsFrames: vi.fn(),
  setStyle: vi.fn(),
  zoomTo: vi.fn(),
  zoom: vi.fn(),
  rotate: vi.fn(),
  render: vi.fn(),
  resize: vi.fn(),
  clear: vi.fn(),
  addUnitCell: vi.fn(),
  removeUnitCell: vi.fn(),
  replicateUnitCell: vi.fn(),
  selectedAtoms: vi.fn(() => DEFAULT_ATOMS),
  setClickable: vi.fn(),
  addLabel: vi.fn((text: string, options: unknown) => ({ text, options })),
  removeLabel: vi.fn(),
  addResLabels: vi.fn(() => [{ residue: true }]),
  addLine: vi.fn((spec: unknown) => ({ spec })),
  removeShape: vi.fn(),
  addSurface: vi.fn(() => Promise.resolve(7)),
  addIsosurface: vi.fn((data: unknown, spec: unknown) => ({ data, spec })),
  removeSurface: vi.fn(),
  pngURI: vi.fn(() => "data:image/png;base64,AAA="),
  apngURI: vi.fn(() => Promise.resolve("data:image/png;base64,APNG=")),
  setFrame: vi.fn(() => Promise.resolve()),
  getFrame: vi.fn(() => 0),
  getNumFrames: vi.fn(() => 1),
  animate: vi.fn(),
  stopAnimate: vi.fn(),
  vibrate: vi.fn(),
  mapAtomProperties: vi.fn(),
};
const createViewer = vi.fn<() => typeof viewer | null>(() => viewer);
vi.mock("3dmol", () => ({
  applyPartialCharges: vi.fn(),
  createViewer: () => createViewer(),
  Gradient: {
    RWB: class MockRwbGradient {
      constructor(
        readonly min: number,
        readonly max: number,
      ) {}
    },
  },
  VolumeData: class MockVolumeData {
    constructor(
      readonly data: string,
      readonly format: string,
    ) {}
  },
}));
const originalOffscreenCanvas = globalThis.OffscreenCanvas;

const PDB_WITH_COORDS = [
  "ATOM      1  C1  LIG A   1       0.000   0.000   0.000  1.00  0.00           C",
  "HETATM    2  O1  LIG A   1       1.200   0.000   0.000  1.00  0.00           O",
].join("\n");
const PDB_WITH_EXPLICIT_HYDROGEN = [
  "HETATM    1  C1  LIG A   1       0.000   0.000   0.000  1.00  0.00           C",
  "HETATM    2  H1  LIG A   1       0.000   0.000   1.090  1.00  0.00           H",
].join("\n");

beforeEach(() => {
  viewer.selectedAtoms.mockReturnValue(DEFAULT_ATOMS);
  viewer.addSurface.mockReturnValue(Promise.resolve(7));
  viewer.addIsosurface.mockReturnValue({ data: null, spec: null });
  viewer.pngURI.mockReturnValue("data:image/png;base64,AAA=");
  viewer.apngURI.mockResolvedValue("data:image/png;base64,APNG=");
  viewer.getFrame.mockReturnValue(0);
  viewer.getNumFrames.mockReturnValue(1);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((contextId) => {
    return ["webgl2", "webgl", "experimental-webgl"].includes(String(contextId)) ? ({} as never) : null;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 420,
    width: 800,
    height: 420,
    toJSON: () => ({}),
  } as DOMRect);
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: vi.fn(() => true) });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  restoreOffscreenCanvas();
});

describe("MoleculeView", () => {
  it("hands a PDB's raw text to 3Dmol as a pdb model and reports atom count", async () => {
    render(<MoleculeView filename="1abc.pdb" text={"ATOM  1  C   LIG\nATOM  2  O   LIG"} />);
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());
    expect(viewer.addModel).toHaveBeenCalledWith(expect.stringContaining("ATOM"), "pdb", { keepH: true });
    expect(await screen.findByText("3 atoms")).toBeInTheDocument();
    expect(screen.getByText("PDB")).toBeInTheDocument();
  });

  it("keeps explicit hydrogens when handing PDB data to 3Dmol", async () => {
    viewer.selectedAtoms.mockReturnValueOnce([
      ...DEFAULT_ATOMS,
      { atom: "H1", elem: "H", index: 3, serial: 4, resn: "LIG", resi: 1, chain: "A", x: 0, y: 0, z: 1.09 },
    ]);
    render(<MoleculeView filename="dmac.pdb" text={PDB_WITH_EXPLICIT_HYDROGEN} />);

    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());

    expect(viewer.addModel).toHaveBeenCalledWith(expect.stringContaining("H1"), "pdb", { keepH: true });
    expect(await screen.findByText("4 atoms")).toBeInTheDocument();
  });

  it("converts a SMILES file to a coordinate-bearing model before rendering", async () => {
    render(<MoleculeView filename="mols.smi" text="CCO ethanol" />);
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());
    const [model, format] = viewer.addModel.mock.calls[0];
    expect(format).toBe("sdf");
    // openchemlib laid out real coordinates (not the raw SMILES string).
    expect(model).not.toContain("CCO ethanol");
    expect(model).toMatch(/-?\d+\.\d{3,}/);
  });

  it("normalizes a POSCAR file before rendering it with the VASP viewer path", async () => {
    render(
      <MoleculeView
        filename="POSCAR_Si"
        text={`Si conventional cell synthetic fixture
5.431
1.0 0.0 0.0
0.0 1.0 0.0
0.0 0.0 1.0
Si
2
Direct
0.000000 0.000000 0.000000
0.250000 0.250000 0.250000
`}
      />,
    );

    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());
    const [model, format] = viewer.addModel.mock.calls[0];
    expect(format).toBe("vasp");
    expect(model).toContain("Si\n2\nDirect\n");
    expect(model).toContain("0.25 0.25 0.25");
    await waitFor(() => expect(viewer.addUnitCell).toHaveBeenCalledWith(undefined, { box: { color: "#7f8794" } }));
    expect(await screen.findByText(/Si2 \| Direct \| a=5\.431 A/)).toBeInTheDocument();

    viewer.addModel.mockClear();
    viewer.addUnitCell.mockClear();
    viewer.removeUnitCell.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Unit cell" }));
    await waitFor(() => expect(viewer.removeUnitCell).toHaveBeenCalled());
    expect(viewer.addModel).not.toHaveBeenCalled();
    expect(viewer.addUnitCell).not.toHaveBeenCalled();
  });

  it("re-applies the style when the user switches render mode", async () => {
    render(<MoleculeView filename="ligand.mol" text="mol" />);
    await waitFor(() => expect(viewer.setStyle).toHaveBeenCalled());
    viewer.setStyle.mockClear();
    viewer.addModel.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "Sphere" }));
    await waitFor(() =>
      expect(viewer.setStyle).toHaveBeenCalledWith({}, expect.objectContaining({ sphere: expect.anything() })),
    );
    expect(viewer.addModel).not.toHaveBeenCalled();
  });

  it("does not duplicate 3Dmol's native drag and wheel handling", async () => {
    render(<MoleculeView filename="ligand.pdb" text={PDB_WITH_COORDS} />);
    const container = await screen.findByLabelText("ligand.pdb 3D molecule viewer");
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());

    fireEvent.pointerDown(container, { button: 0, buttons: 1, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(container, { buttons: 1, clientX: 50, clientY: 30, pointerId: 1 });
    fireEvent.wheel(container, { deltaY: 100 });

    expect(viewer.rotate).not.toHaveBeenCalled();
    expect(viewer.zoom).not.toHaveBeenCalled();
  });

  it("keeps advanced controls collapsed until requested", async () => {
    render(<MoleculeView filename="ligand.pdb" text={PDB_WITH_COORDS} />);
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());

    expect(screen.queryByLabelText("Selection preset")).not.toBeInTheDocument();

    await openAdvancedControls();

    expect(screen.getByLabelText("Selection preset")).toBeInTheDocument();
  });

  it("keeps atom picking inactive until an atom-picking tool is enabled", async () => {
    render(<MoleculeView filename="ligand.pdb" text={PDB_WITH_COORDS} />);
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());

    expect(viewer.setClickable.mock.calls.some((call) => call[1] === true)).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Measure distance" }));
    await waitFor(() => expect(viewer.setClickable.mock.calls.some((call) => call[1] === true)).toBe(true));

    await userEvent.click(screen.getByRole("button", { name: "Measure distance" }));
    await waitFor(() => {
      const lastCall = viewer.setClickable.mock.calls[viewer.setClickable.mock.calls.length - 1];
      expect(lastCall?.[1]).toBe(false);
    });
  });

  it("supports line and cross render styles", async () => {
    render(<MoleculeView filename="ligand.mol" text="mol" />);
    await waitFor(() => expect(viewer.setStyle).toHaveBeenCalled());
    viewer.setStyle.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "Line" }));
    await waitFor(() => expect(viewer.setStyle).toHaveBeenCalledWith({}, expect.objectContaining({ line: expect.anything() })));

    viewer.setStyle.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "Cross" }));
    await waitFor(() => expect(viewer.setStyle).toHaveBeenCalledWith({}, expect.objectContaining({ cross: expect.anything() })));
  });

  it("applies element selection actions and view effects", async () => {
    render(<MoleculeView filename="ligand.pdb" text={PDB_WITH_COORDS} />);
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());
    await openAdvancedControls();
    viewer.setStyle.mockClear();
    viewer.setProjection.mockClear();
    viewer.setViewStyle.mockClear();

    await userEvent.type(screen.getByLabelText("Selection element"), "O");
    await userEvent.selectOptions(screen.getByLabelText("Selection action"), "highlight");
    await waitFor(() =>
      expect(viewer.setStyle).toHaveBeenCalledWith(
        { elem: "O" },
        expect.objectContaining({ stick: expect.objectContaining({ color: "#f59e0b" }) }),
      ),
    );

    await userEvent.selectOptions(screen.getByLabelText("View effect"), "outline");
    await waitFor(() => expect(viewer.setViewStyle).toHaveBeenCalledWith(expect.objectContaining({ style: "outline" })));

    await userEvent.click(screen.getByRole("button", { name: "Orthographic projection" }));
    await waitFor(() => expect(viewer.setProjection).toHaveBeenCalledWith("orthographic"));
  });

  it("adds element labels through 3Dmol when the label tool is enabled", async () => {
    render(<MoleculeView filename="ligand.pdb" text={PDB_WITH_COORDS} />);
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Element labels" }));

    await waitFor(() => expect(viewer.addLabel).toHaveBeenCalledWith("C1", expect.objectContaining({ inFront: true })));
  });

  it("shows clicked atom details and draws a distance measurement", async () => {
    render(<MoleculeView filename="ligand.pdb" text={PDB_WITH_COORDS} />);
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Atom click information" }));
    await waitFor(() => expect(viewer.setClickable).toHaveBeenCalledWith({}, true, expect.any(Function)));

    act(() => atomClickCallback()(DEFAULT_ATOMS[0]));
    expect(await screen.findByText("C1 #1")).toBeInTheDocument();
    expect(screen.getByText("x=0.000 y=0.000 z=0.000")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Measure distance" }));
    expect(await screen.findByText(/Distance: select 2 atoms/)).toBeInTheDocument();
    act(() => {
      atomClickCallback()(DEFAULT_ATOMS[0]);
      atomClickCallback()(DEFAULT_ATOMS[1]);
    });

    expect(await screen.findByText(/Distance C1-O2: 1\.20 A/)).toBeInTheDocument();
    expect(viewer.addLine).toHaveBeenCalledWith(expect.objectContaining({ dashed: true }));
  });

  it("toggles a VDW molecular surface", async () => {
    render(<MoleculeView filename="ligand.pdb" text={PDB_WITH_COORDS} />);
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Molecular surface" }));

    await waitFor(() => expect(viewer.addSurface).toHaveBeenCalledWith("VDW", expect.objectContaining({ opacity: 0.35 }), {}, {}));
    await userEvent.click(screen.getByRole("button", { name: "Molecular surface" }));
    await waitFor(() => expect(viewer.removeSurface).toHaveBeenCalledWith(7));
  });

  it("uses surface type, scope, and selector controls", async () => {
    render(<MoleculeView filename="ligand.pdb" text={PDB_WITH_COORDS} />);
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());
    await openAdvancedControls();

    await userEvent.type(screen.getByLabelText("Selection element"), "O");
    await userEvent.selectOptions(screen.getByLabelText("Surface type"), "SAS");
    await userEvent.selectOptions(screen.getByLabelText("Surface scope"), "selection");
    await userEvent.selectOptions(screen.getByLabelText("Surface color mode"), "element");
    await userEvent.click(screen.getByRole("button", { name: "Molecular surface" }));

    await waitFor(() =>
      expect(viewer.addSurface).toHaveBeenCalledWith(
        "SAS",
        expect.objectContaining({ colorscheme: "Jmol", opacity: 0.35 }),
        { elem: "O" },
        {},
      ),
    );
  });

  it("maps cube volume data onto a surface", async () => {
    render(<MoleculeView filename="esp.cube" text={"cube volume fixture"} />);
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());
    expect(await screen.findByText("3 atoms")).toBeInTheDocument();
    await openAdvancedControls();

    await userEvent.click(screen.getByRole("button", { name: "Molecular surface" }));

    await waitFor(() =>
      expect(viewer.addSurface).toHaveBeenCalledWith(
        "VDW",
        expect.objectContaining({ voldata: expect.objectContaining({ format: "cube" }), volscheme: expect.anything() }),
        {},
        {},
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: "Cube isosurface" }));
    await waitFor(() =>
      expect(viewer.addIsosurface).toHaveBeenCalledWith(
        expect.objectContaining({ format: "cube" }),
        expect.objectContaining({ color: "#2563eb", isoval: 0.01, opacity: 0.65 }),
      ),
    );
  });

  it("plays and stops trajectory frames when a structure has multiple frames", async () => {
    viewer.getNumFrames.mockReturnValue(3);
    render(<MoleculeView filename="trajectory.xyz" text={"1\nframe 1\nC 0 0 0\n1\nframe 2\nC 1 0 0\n"} />);
    await waitFor(() => expect(viewer.addModelsAsFrames).toHaveBeenCalled());
    await openAdvancedControls();

    await waitFor(() => expect(screen.getByRole("button", { name: "Play trajectory" })).not.toBeDisabled());
    await userEvent.click(screen.getByRole("button", { name: "Play trajectory" }));
    expect(viewer.animate).toHaveBeenCalledWith({ loop: "forward", reps: 0, interval: 90 });

    await userEvent.click(screen.getByRole("button", { name: "Stop trajectory" }));
    expect(viewer.stopAnimate).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Next frame" }));
    await waitFor(() => expect(viewer.setFrame).toHaveBeenCalledWith(1));

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    await userEvent.click(screen.getByRole("button", { name: "Export APNG" }));
    expect(viewer.apngURI).toHaveBeenCalledWith(3);
    expect(clickSpy).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Generate vibration frames" }));
    expect(viewer.vibrate).toHaveBeenCalledWith(12, 1, true, expect.objectContaining({ color: "#f59e0b" }));
  });

  it("exports the current canvas as a PNG data URI", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<MoleculeView filename="ligand.pdb" text={PDB_WITH_COORDS} />);
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());

    await userEvent.click(screen.getByRole("button", { name: "Export PNG" }));

    expect(viewer.pngURI).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(await screen.findByText("PNG export started.")).toBeInTheDocument();
  });

  it("offers Cartoon only for macromolecules (small molecules lack residues)", async () => {
    const { rerender } = render(<MoleculeView filename="ligand.mol" text="small molecule" />);
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());
    // A small molecule: cartoon would crash 3Dmol on missing resn, so it's hidden.
    expect(screen.queryByRole("button", { name: "Cartoon" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stick" })).toBeInTheDocument();

    // A protein (many alpha carbons) gets the cartoon option.
    const protein = Array.from({ length: 25 }, (_, i) => `ATOM  ${i} CA  ALA`).join("\n");
    rerender(<MoleculeView filename="1abc.pdb" text={protein} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cartoon" })).toBeInTheDocument());
  });

  it("can replicate VASP unit cells and draw axis labels", async () => {
    render(
      <MoleculeView
        filename="POSCAR_Si"
        text={`Si conventional cell synthetic fixture
5.431
1.0 0.0 0.0
0.0 1.0 0.0
0.0 0.0 1.0
Si
2
Direct
0.000000 0.000000 0.000000
0.250000 0.250000 0.250000
`}
      />,
    );
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());
    await openAdvancedControls();
    viewer.replicateUnitCell.mockClear();
    viewer.addUnitCell.mockClear();

    const replicateInput = screen.getByLabelText("Replicate unit cell");
    await userEvent.clear(replicateInput);
    await userEvent.type(replicateInput, "2 2 2{Enter}");
    await waitFor(() => expect(viewer.replicateUnitCell).toHaveBeenCalledWith(2, 2, 2, undefined, true, false));
    expect(replicateInput).toHaveValue("2x2x2");

    await userEvent.click(screen.getByRole("button", { name: "Unit cell axis labels" }));
    await waitFor(() =>
      expect(viewer.addUnitCell).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ alabel: "a", blabel: "b", clabel: "c" }),
      ),
    );
  });

  it("does not apply invalid unit-cell replication text", async () => {
    render(
      <MoleculeView
        filename="POSCAR_Si"
        text={`Si conventional cell synthetic fixture
5.431
1.0 0.0 0.0
0.0 1.0 0.0
0.0 0.0 1.0
Si
2
Direct
0.000000 0.000000 0.000000
0.250000 0.250000 0.250000
`}
      />,
    );
    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());
    await openAdvancedControls();
    viewer.replicateUnitCell.mockClear();

    const replicateInput = screen.getByLabelText("Replicate unit cell");
    await userEvent.clear(replicateInput);
    await userEvent.type(replicateInput, "20x1x1{Enter}");

    expect(viewer.replicateUnitCell).not.toHaveBeenCalled();
    expect(replicateInput).toHaveValue("1x1x1");
    expect(screen.getByText(/Use cell replication as A x B x C integers/)).toBeInTheDocument();
  });

  it("explains a SMILES file with no parseable structures", async () => {
    render(<MoleculeView filename="empty.smi" text={"   \n# comment\n"} />);
    expect(await screen.findByText(/No chemical structures found/)).toBeInTheDocument();
    expect(viewer.addModel).not.toHaveBeenCalled();
  });

  it("shows a clear fallback when the 3D viewer cannot initialize", async () => {
    createViewer.mockReturnValueOnce(null);
    render(<MoleculeView filename="dmac.pdb" text={PDB_WITH_COORDS} />);

    expect(await screen.findByTestId("structure-fallback-svg")).toBeInTheDocument();
    expect(screen.getByText(/3D WebGL preview is unavailable here/)).toBeInTheDocument();
    expect(screen.queryByText(/3D viewer could not start/)).not.toBeInTheDocument();
    expect(screen.queryByText(rawTextMatcher("ATOM"))).not.toBeInTheDocument();
  });

  it("explains when a parser accepts the format but produces no atoms", async () => {
    viewer.selectedAtoms.mockReturnValueOnce([]);
    render(<MoleculeView filename="tfsi.xyz" text={"1\nTFSI\nN 0 0 0"} />);

    expect(await screen.findByText(/3D XYZ preview could not parse atoms here/)).toBeInTheDocument();
    expect(screen.getByTestId("structure-fallback-svg")).toBeInTheDocument();
    expect(screen.queryByText(rawTextMatcher("N 0 0 0"))).not.toBeInTheDocument();
  });

  it("shows an SVG structure preview when WebGL is missing", async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockImplementation(() => null);
    render(<MoleculeView filename="caffeine.pdb" text={PDB_WITH_COORDS} />);

    expect(await screen.findByTestId("structure-fallback-svg")).toBeInTheDocument();
    expect(screen.getByText(/WebGL is unavailable/)).toBeInTheDocument();
    expect(screen.getByText("2 atoms")).toBeInTheDocument();
    expect(createViewer).not.toHaveBeenCalled();
    expect(screen.queryByText(rawTextMatcher("ATOM"))).not.toBeInTheDocument();
  });

  it("bypasses 3Dmol's OffscreenCanvas path when only regular canvas WebGL works", async () => {
    class UnsupportedOffscreenCanvas {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}

      getContext() {
        return null;
      }
    }
    Object.defineProperty(globalThis, "OffscreenCanvas", {
      configurable: true,
      writable: true,
      value: UnsupportedOffscreenCanvas as unknown as typeof OffscreenCanvas,
    });
    createViewer.mockImplementationOnce(() => {
      expect(globalThis.OffscreenCanvas).toBeUndefined();
      return viewer;
    });

    render(<MoleculeView filename="dmac.pdb" text={PDB_WITH_COORDS} />);

    await waitFor(() => expect(viewer.addModel).toHaveBeenCalled());
    expect(createViewer).toHaveBeenCalled();
    expect(globalThis.OffscreenCanvas).toBe(UnsupportedOffscreenCanvas);
    expect(screen.getByText("3D")).toBeInTheDocument();
  });
});

function rawTextMatcher(needle: string) {
  return (_: string, element: Element | null) =>
    element?.tagName.toLowerCase() === "pre" && Boolean(element.textContent?.includes(needle));
}

async function openAdvancedControls() {
  await userEvent.click(screen.getByRole("button", { name: "Advanced controls" }));
}

function atomClickCallback() {
  const callback = viewer.setClickable.mock.calls[viewer.setClickable.mock.calls.length - 1]?.[2];
  if (typeof callback !== "function") throw new Error("atom click callback was not registered");
  return callback as (atom: (typeof DEFAULT_ATOMS)[number]) => void;
}

function restoreOffscreenCanvas() {
  if (originalOffscreenCanvas === undefined) {
    Reflect.deleteProperty(globalThis, "OffscreenCanvas");
    return;
  }
  Object.defineProperty(globalThis, "OffscreenCanvas", {
    configurable: true,
    writable: true,
    value: originalOffscreenCanvas,
  });
}
