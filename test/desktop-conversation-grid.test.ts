import { describe, expect, it } from "vitest";
import { planConversationGrid, planResizableConversationGrid, resizeConversationGrid } from "../src/desktop/conversation-layout";

function plan(width: number, height: number, count: number, zoom = 1) {
  return planConversationGrid(width, height, Array<boolean>(count).fill(false), zoom);
}

function rowsByColumn(cells: ReturnType<typeof plan>) {
  const columns = new Map<number, number>();
  for (const { x } of cells) columns.set(x, (columns.get(x) ?? 0) + 1);
  return [...columns.values()];
}

describe("desktop conversation grid", () => {
  it.each([
    [1536, 4, [1, 1, 2]], [1536, 7, [2, 2, 3]],
    [1280, 4, [2, 2]], [1280, 7, [2, 2, 3]],
    [1920, 4, [1, 1, 1, 1]], [1920, 7, [1, 2, 2, 2]],
  ] as const)("lays out a %i px window with %i chats as %j rows per column", (windowWidth, count, rows) => {
    expect(rowsByColumn(plan(windowWidth - 260, 800, count))).toEqual(rows);
  });

  it("assigns cells in open order, with one DIP gaps and full use of the area", () => {
    expect(plan(1020, 800, 4)).toEqual([
      { x: 0, y: 0, width: 510, height: 400 },
      { x: 0, y: 401, width: 510, height: 399 },
      { x: 511, y: 0, width: 509, height: 400 },
      { x: 511, y: 401, width: 509, height: 399 },
    ]);
    expect(plan(1020, 800, 7).map(cell => cell.width)).toEqual([340, 340, 339, 339, 339, 339, 339]);
    expect(planConversationGrid(400, 330, [true])).toEqual([{ x: 0, y: 0, width: 400, height: 330 }]);
  });

  it("uses CSS zoom for both the column target and the row limit in DIPs", () => {
    expect(rowsByColumn(plan(1082, 800, 4))).toEqual([1, 1, 2]);
    expect(rowsByColumn(plan(1082, 800, 4, 1.15))).toEqual([2, 2]);
    expect(rowsByColumn(plan(1020, 650, 7))).toEqual([2, 2, 3]);
    expect(rowsByColumn(plan(1020, 650, 7, 1.15))).toEqual([1, 2, 2, 2]);
  });

  it("adds columns in short windows to keep all the chats in one or two rows", () => {
    expect(rowsByColumn(plan(1020, 400, 7))).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(rowsByColumn(plan(1020, 401, 7))).toEqual([1, 2, 2, 2]);
  });

  it("widens a column for Files in any of its rows only when all column minimums fit", () => {
    const files = [false, false, false, true];
    const opened = planConversationGrid(1020, 800, files);
    expect(opened.map(cell => cell.width)).toEqual([458, 458, 561, 561]);
    expect(rowsByColumn(opened)).toEqual([2, 2]);
    expect(opened.map(({ y, height }) => ({ y, height }))).toEqual(plan(1020, 800, 4).map(({ y, height }) => ({ y, height })));
    expect(planConversationGrid(922, 800, files).map(cell => cell.width)).toEqual([360, 360, 561, 561]);
    expect(planConversationGrid(921, 800, files)).toEqual(plan(921, 800, 4));
    expect(planConversationGrid(1020, 800, [true, false, false, true])).toEqual(plan(1020, 800, 4));
  });
});

describe("resizable desktop conversation grid", () => {
  const closed = (count: number) => Array<boolean>(count).fill(false);
  const column = { axis: "column", column: 0, row: 0, revision: 3 };
  const row = { axis: "row", column: 2, row: 0, revision: 3 };

  it("keeps phase 5's order and Files widening until the first drag", () => {
    const files = [false, false, false, true];
    const base = planResizableConversationGrid(1020, 800, closed(4));
    const open = planResizableConversationGrid(1020, 800, files);
    expect(base.shape).toEqual([2, 2]);
    expect(base.widths).toEqual([508, 507]);
    expect(open.widths).toEqual([454, 561]);
    expect(open.heights).toEqual(base.heights);
    const exact = planResizableConversationGrid(922, 800, files);
    expect(exact.widths).toEqual([360, 561]);
    expect(exact.dividers.find(divider => divider.axis === "column")?.width).toBe(1);
    expect(planResizableConversationGrid(921, 800, files).widths).toEqual([458, 458]);
  });

  it("clamps both sides of a column drag and leaves the other tracks alone", () => {
    const grid = planResizableConversationGrid(1280, 800, closed(7));
    expect(grid.widths).toEqual([424, 423, 423]);
    const left = resizeConversationGrid(grid, 3, { ...column, position: 0 });
    expect(left?.columns?.fractions).toHaveLength(3);
    const next = planResizableConversationGrid(1280, 800, closed(7), 1, left);
    expect(next.widths).toEqual([360, 487, 423]);
    const right = resizeConversationGrid(next, 3, { ...column, position: 1280 });
    const last = planResizableConversationGrid(1280, 800, closed(7), 1, right);
    expect(last.widths).toEqual([487, 360, 423]);
    expect(last.heights).toEqual(grid.heights);
    expect(last.cells.slice(-3)).toEqual(grid.cells.slice(-3));
  });

  it("clamps fractions as the window shrinks and restores them when it grows back", () => {
    const grid = planResizableConversationGrid(1280, 800, closed(7));
    const left = resizeConversationGrid(grid, 3, { ...column, position: 0 });
    const next = planResizableConversationGrid(1280, 800, closed(7), 1, left);
    const up = resizeConversationGrid(next, 3, { ...row, position: 0 });
    const small = planResizableConversationGrid(1200, 660, closed(7), 1, up);
    expect(small.shape).toEqual([2, 2, 3]);
    expect(small.widths).toEqual([360, 444, 386]);
    expect(small.heights[2]).toEqual([200, 249, 201]);
    expect(small.cells.at(-1)).toMatchObject({ x: 814, y: 459, width: 386, height: 201 });
    const grown = planResizableConversationGrid(1280, 800, closed(7), 1, small.sizes);
    expect(grown.widths).toEqual([360, 487, 423]);
    expect(grown.heights[2]).toEqual([200, 327, 263]);
  });

  it("uses zoomed minima for drags on either axis", () => {
    const grid = planResizableConversationGrid(1500, 900, closed(7), 1.25);
    const left = resizeConversationGrid(grid, 3, { ...column, position: 0 });
    const next = planResizableConversationGrid(1500, 900, closed(7), 1.25, left);
    expect(next.widths).toEqual([450, 544, 496]);
    const down = resizeConversationGrid(next, 3, { ...row, position: 900 });
    const last = planResizableConversationGrid(1500, 900, closed(7), 1.25, down);
    expect(last.heights[2]).toEqual([344, 250, 296]);
    expect(last.heights.slice(0, 2)).toEqual(grid.heights.slice(0, 2));
  });

  it("keeps a docked column's drag minimum and holds widths through Files toggles", () => {
    const files = [false, false, false, true];
    const grid = planResizableConversationGrid(1020, 800, files);
    expect(resizeConversationGrid(grid, 3, { ...column, position: 1020 })).toBeUndefined();
    const drag = resizeConversationGrid(grid, 3, { ...column, position: 0 });
    const opened = planResizableConversationGrid(1020, 800, files, 1, drag);
    const shut = planResizableConversationGrid(1020, 800, closed(4), 1, drag);
    expect(opened.widths).toEqual([360, 655]);
    expect(shut.cells).toEqual(opened.cells);
    const resized = planResizableConversationGrid(938, 800, closed(4), 1, drag);
    expect(resized.widths).toEqual([360, 573]);
    const rebalanced = resizeConversationGrid(shut, 3, { ...column, position: 1020 });
    expect(planResizableConversationGrid(1020, 800, files, 1, rebalanced).widths).toEqual([655, 360]);
    const rowOnly = resizeConversationGrid(grid, 3, { ...row, column: 1, position: 300 });
    expect(planResizableConversationGrid(1020, 800, closed(4), 1, rowOnly).widths).toEqual(grid.widths);
    expect(planResizableConversationGrid(938, 800, files, 1, rowOnly).widths).toEqual([372, 561]);
    expect(planResizableConversationGrid(938, 800, closed(4), 1, rowOnly).widths).toEqual([372, 561]);
  });

  it("drops changed shapes and resets only the requested axis on double-click", () => {
    const grid = planResizableConversationGrid(1280, 800, closed(7));
    const movedColumns = resizeConversationGrid(grid, 3, { ...column, position: 0 });
    const columns = planResizableConversationGrid(1280, 800, closed(7), 1, movedColumns);
    const movedRows = resizeConversationGrid(columns, 3, { ...row, position: 0 });
    const both = planResizableConversationGrid(1280, 800, closed(7), 1, movedRows);
    const resetRows = resizeConversationGrid(both, 3, { ...row, position: null });
    expect(planResizableConversationGrid(1280, 800, closed(7), 1, resetRows).cells).toEqual(columns.cells);
    const resetColumns = resizeConversationGrid(both, 3, { ...column, position: null });
    const mainDefault = planResizableConversationGrid(1280, 800, closed(7), 1, resetColumns);
    expect(mainDefault.widths).toEqual(grid.widths);
    expect(mainDefault.heights).toEqual(both.heights);
    for (const changed of [
      planResizableConversationGrid(1280, 800, closed(6), 1, movedRows),
      planResizableConversationGrid(1500, 800, closed(7), 1, movedRows),
    ]) {
      expect(changed.sizes).toBeUndefined();
      expect(changed.cells).toEqual(planResizableConversationGrid(changed.width, changed.height,
        closed(changed.cells.length)).cells);
    }
  });

  it("refuses invalid or stale input and ignores invalid saved fractions", () => {
    const grid = planResizableConversationGrid(1280, 800, closed(7));
    for (const request of [
      null, [], { ...column, revision: 2 }, { ...column, axis: "diagonal" },
      { ...column, column: 2 }, { ...row, row: 2 }, { ...column, column: "0" },
      ...[undefined, NaN, Infinity, -1, 1281, 1.5, "10"].map(position => ({ ...column, position })),
    ]) expect(resizeConversationGrid(grid, 3, request)).toBeUndefined();
    const stored = {
      shape: grid.shape, rows: [null, null, null],
      columns: { fractions: [0, 0, 0], docked: [false, false, false], gutterDockCount: 0 },
    };
    expect(planResizableConversationGrid(1280, 800, closed(7), 1, stored).cells).toEqual(grid.cells);
  });

  it.each([[0, 800], [1280, 0], [1, 1]])("keeps transient %i by %i layouts inside the area", (width, height) => {
    const grid = planResizableConversationGrid(width, height, closed(7));
    expect(grid.dividers).toEqual([]);
    expect(Math.max(...grid.cells.map(cell => cell.x + cell.width))).toBe(width);
    expect(Math.max(...grid.cells.map(cell => cell.y + cell.height))).toBe(height);
  });
});
