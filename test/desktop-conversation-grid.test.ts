import { describe, expect, it } from "vitest";
import { planConversationGrid } from "../src/desktop/conversation-layout";

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
