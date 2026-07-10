import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { VaspSummaryView } from "./VaspSummaryView";

describe("VaspSummaryView", () => {
  it("renders parsed OSZICAR energies and the electronic convergence state", () => {
    render(
      <VaspSummaryView
        filename="OSZICAR"
        text={"DAV: 1 -1.2000\n 1 F= -1.1000 E0= -1.0500 d E = -0.01\n"}
      />,
    );

    expect(screen.getByText("Final energy")).toBeInTheDocument();
    expect(screen.getByText("-1.10000000 eV")).toBeInTheDocument();
    expect(screen.getByText("Sigma->0")).toBeInTheDocument();
    expect(screen.getByText("-1.05000000 eV")).toBeInTheDocument();
    expect(screen.getByText("Energy trace")).toBeInTheDocument();
    expect(screen.getByText("No convergence marker found in previewed text")).toBeInTheDocument();
  });
});
