import { describe, expect, it } from "vitest";
import {
  MAX_DIFF_EXPAND_BYTES,
  expandDiffToWholeFile,
  firstChangedLine,
  planEditRevert,
} from "../src/diff-view";

describe("expandDiffToWholeFile", () => {
  it("expands a pending single-site edit against the before file", () => {
    const result = expandDiffToWholeFile({
      diskText: "header\nconst answer = 41;\nfooter\n",
      oldRegion: "41",
      newRegion: "42",
      diskIsBefore: true,
      sites: [{ oldText: "41", newText: "42", oldLine: 2, newLine: 2 }],
    });

    expect(result).toEqual({
      oldText: "header\nconst answer = 41;\nfooter\n",
      newText: "header\nconst answer = 42;\nfooter\n",
      firstChangedLine: 1,
      wholeFile: true,
    });
  });

  it("uses the completed site's post-edit line instead of rewriting an older matching token", () => {
    const result = expandDiffToWholeFile({
      diskText: "const existing = true;\nconst changed = true;\n",
      oldRegion: "false",
      newRegion: "true",
      diskIsBefore: false,
      sites: [{ oldText: "false", newText: "true", oldLine: 2, newLine: 2 }],
    });

    expect(result.oldText).toBe("const existing = true;\nconst changed = false;\n");
    expect(result.newText).toBe("const existing = true;\nconst changed = true;\n");
  });

  it("uses the pending site's line when the old pattern occurs more than once", () => {
    const result = expandDiffToWholeFile({
      diskText: "TOKEN first\nTOKEN second\n",
      oldRegion: "TOKEN",
      newRegion: "VALUE",
      diskIsBefore: true,
      sites: [{ oldText: "TOKEN", newText: "VALUE", oldLine: 2, newLine: 2 }],
    });

    expect(result.newText).toBe("TOKEN first\nVALUE second\n");
  });

  it("replaces all occurrences only when replace_all is explicit", () => {
    const result = expandDiffToWholeFile({
      diskText: "TOKEN one\nTOKEN two\n",
      oldRegion: "TOKEN",
      newRegion: "VALUE",
      diskIsBefore: true,
      replaceAll: true,
      // The pre-write echo only positions the first site, but rawInput says the
      // operation intentionally targets every occurrence.
      sites: [{ oldText: "TOKEN", newText: "VALUE", oldLine: 1, newLine: 1 }],
    });

    expect(result.newText).toBe("VALUE one\nVALUE two\n");
  });

  it("replaces only the first occurrence without site data or replace_all", () => {
    const result = expandDiffToWholeFile({
      diskText: "TOKEN one\nTOKEN two\n",
      oldRegion: "TOKEN",
      newRegion: "VALUE",
      diskIsBefore: true,
    });

    expect(result.newText).toBe("VALUE one\nTOKEN two\n");
  });

  it("reconstructs multiple completed replace-all sites bottom-up when replacements changed line counts", () => {
    const after = [
      "header",
      "alpha",
      "bravo",
      "charlie",
      "middle",
      "alpha",
      "bravo",
      "charlie",
      "tail",
      "",
    ].join("\n");
    const sites = [
      { oldText: "EXPAND", newText: "alpha\nbravo\ncharlie", oldLine: 2, newLine: 2 },
      { oldText: "EXPAND", newText: "alpha\nbravo\ncharlie", oldLine: 6, newLine: 6 },
    ];

    const result = expandDiffToWholeFile({
      diskText: after,
      oldRegion: "EXPAND",
      newRegion: "alpha\nbravo\ncharlie",
      diskIsBefore: false,
      replaceAll: true,
      sites,
    });

    expect(result.oldText).toBe("header\nEXPAND\nmiddle\nEXPAND\ntail\n");
    expect(result.newText).toBe(after);
    expect(result.firstChangedLine).toBe(1);
  });

  it("reconstructs a completed deletion even though the block's new region is empty", () => {
    const result = expandDiffToWholeFile({
      diskText: "before\nafter\n",
      oldRegion: "remove me\n",
      newRegion: "",
      diskIsBefore: false,
      sites: [{ oldText: "remove me\n", newText: "", oldLine: 2, newLine: 2 }],
    });

    expect(result.oldText).toBe("before\nremove me\nafter\n");
    expect(result.newText).toBe("before\nafter\n");
    expect(result.wholeFile).toBe(true);
  });

  it("uses line prefixes from site text to locate a same-line token precisely", () => {
    const result = expandDiffToWholeFile({
      diskText: "item 1: NEW here\nitem 2: NEW here\n",
      oldRegion: "OLD",
      newRegion: "NEW",
      diskIsBefore: false,
      sites: [{
        oldText: "item 2: OLD",
        newText: "item 2: NEW",
        oldLine: 2,
        newLine: 2,
      }],
    });

    expect(result.oldText).toBe("item 1: NEW here\nitem 2: OLD here\n");
  });

  it("normalizes both sides when a CRLF disk file meets LF wire regions", () => {
    const result = expandDiffToWholeFile({
      diskText: "before\r\nold one\r\nold two\r\nafter\r\n",
      oldRegion: "old one\nold two",
      newRegion: "new one\nnew two",
      diskIsBefore: true,
      sites: [{
        oldText: "old one\nold two",
        newText: "new one\nnew two",
        oldLine: 2,
        newLine: 2,
      }],
    });

    expect(result.wholeFile).toBe(true);
    expect(result.oldText).toBe("before\nold one\nold two\nafter\n");
    expect(result.newText).toBe("before\nnew one\nnew two\nafter\n");
  });

  it("uses disk as the real before side for a pending whole-file overwrite echo", () => {
    const result = expandDiffToWholeFile({
      diskText: "old file\nwith context\n",
      oldRegion: "",
      newRegion: "replacement\n",
      diskIsBefore: true,
    });

    expect(result.oldText).toBe("old file\nwith context\n");
    expect(result.newText).toBe("replacement\n");
    expect(result.wholeFile).toBe(true);
  });

  it("leaves a new-file creation as the already-whole bare region", () => {
    const result = expandDiffToWholeFile({
      diskText: undefined,
      oldRegion: "",
      newRegion: "new file\n",
      diskIsBefore: true,
    });

    expect(result).toEqual({
      oldText: "",
      newText: "new file\n",
      firstChangedLine: 0,
      wholeFile: false,
    });
  });

  it("falls back to the bare region when the disk file cannot be read", () => {
    const result = expandDiffToWholeFile({
      diskText: undefined,
      oldRegion: "old",
      newRegion: "new",
      diskIsBefore: false,
    });

    expect(result.oldText).toBe("old");
    expect(result.newText).toBe("new");
    expect(result.wholeFile).toBe(false);
  });

  it("falls back when the expected region is no longer on disk", () => {
    const result = expandDiffToWholeFile({
      diskText: "the file moved on\n",
      oldRegion: "old",
      newRegion: "new",
      diskIsBefore: false,
    });

    expect(result).toMatchObject({ oldText: "old", newText: "new", wholeFile: false });
  });

  it("falls back rather than guessing when a supplied site coordinate is stale", () => {
    const result = expandDiffToWholeFile({
      diskText: "NEW first\nNEW second\n",
      oldRegion: "OLD",
      newRegion: "NEW",
      diskIsBefore: false,
      sites: [{ oldText: "OLD", newText: "NEW", oldLine: 9, newLine: 9 }],
    });

    expect(result).toMatchObject({ oldText: "OLD", newText: "NEW", wholeFile: false });
  });

  it("skips expansion above the memory guard", () => {
    const result = expandDiffToWholeFile({
      diskText: "x".repeat(MAX_DIFF_EXPAND_BYTES + 1),
      oldRegion: "x",
      newRegion: "y",
      diskIsBefore: true,
    });

    expect(result.wholeFile).toBe(false);
    expect(result.oldText).toBe("x");
  });
});

describe("firstChangedLine", () => {
  it("returns the first 0-based differing line and ignores CRLF-vs-LF alone", () => {
    expect(firstChangedLine("same\r\nold\r\n", "same\nnew\n")).toBe(1);
    expect(firstChangedLine("same\r\n", "same\n")).toBe(0);
  });

  it("returns the shared line count when one text only appends lines", () => {
    expect(firstChangedLine("one\ntwo", "one\ntwo\nthree")).toBe(2);
  });
});

describe("planEditRevert", () => {
  it("reverts a single-site edit by reconstructing the whole pre-edit file", () => {
    expect(planEditRevert({
      oldText: "41",
      newText: "42",
      currentText: "header\nconst answer = 42;\nfooter\n",
    })).toEqual({ action: "write", text: "header\nconst answer = 41;\nfooter\n" });
  });

  it("deletes a pure creation whose content still matches what the edit wrote", () => {
    expect(planEditRevert({
      oldText: "",
      newText: "hello\n",
      currentText: "hello\n",
    })).toEqual({ action: "delete" });
  });

  it("asks for confirmation before deleting a creation that has since diverged", () => {
    expect(planEditRevert({
      oldText: "",
      newText: "hello\n",
      currentText: "hello\nand more\n",
    })).toEqual({ action: "delete-confirm" });
  });

  it("refuses a creation whose file no longer exists", () => {
    expect(planEditRevert({ oldText: "", newText: "hello\n", currentText: undefined }))
      .toEqual({ action: "unreadable" });
  });

  it("refuses any edit when the file can't be read", () => {
    expect(planEditRevert({ oldText: "a", newText: "b", currentText: undefined }))
      .toEqual({ action: "unreadable" });
  });

  it("reports a conflict when the edited region can no longer be found", () => {
    expect(planEditRevert({
      oldText: "old-region",
      newText: "new-region",
      currentText: "the file moved on and no longer contains that region",
    })).toEqual({ action: "conflict" });
  });

  it("reverts every site of a replace_all edit", () => {
    expect(planEditRevert({
      oldText: "TOKEN",
      newText: "REPLACED",
      replaceAll: true,
      currentText: "REPLACED once, REPLACED twice",
    })).toEqual({ action: "write", text: "TOKEN once, TOKEN twice" });
  });

  it("reverts cleanly when site has oldLine but newLine is undefined (e.g. line count changed)", () => {
    expect(planEditRevert({
      oldText: "old line",
      newText: "new line 1\nnew line 2",
      sites: [{ oldText: "old line", newText: "new line 1\nnew line 2", oldLine: 2, newLine: undefined }],
      currentText: "header\nnew line 1\nnew line 2\nfooter\n",
    })).toEqual({ action: "write", text: "header\nold line\nfooter\n" });
  });
});

