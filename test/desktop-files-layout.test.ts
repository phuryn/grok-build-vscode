import { expect, it } from "vitest";
import { planDesktopFiles } from "../src/desktop/file-tree-panel";

it("keeps the overlay at least 160 CSS px on a narrow tile", () => {
  expect(planDesktopFiles(240, 1, 290)).toMatchObject({ overlay: true, minWidth: 160, width: 160 });
});

it("caps the overlay at 62 percent of the tile, rounded in CSS px", () => {
  expect(planDesktopFiles(340, 1, 290)).toMatchObject({ overlay: true, width: 211 });
});

it("keeps the preferred width between the floor and the cap", () => {
  expect(planDesktopFiles(340, 1, 200)).toMatchObject({ overlay: true, width: 200 });
});

it("applies zoom to the docking threshold and converts DIPs before capping the overlay", () => {
  expect(planDesktopFiles(425, 1.25, 290)).toMatchObject({ overlay: true, width: 211 });
  expect(planDesktopFiles(701, 1.25, 290)).toMatchObject({ overlay: true });
  expect(planDesktopFiles(702, 1.25, 290)).toMatchObject({ overlay: false, width: 200 });
});

it("docks at exactly 561 px and overlays one pixel below", () => {
  expect(planDesktopFiles(560, 1, 290)).toMatchObject({ overlay: true, width: 290 });
  expect(planDesktopFiles(561, 1, 290)).toMatchObject({ overlay: false, minWidth: 200, width: 200 });
  expect(planDesktopFiles(661, 1, 290)).toMatchObject({ overlay: false, width: 290 });
});
