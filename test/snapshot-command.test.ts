import { describe, it, expect, vi } from "vitest";
import { handleTakeSnapshotCommand } from "../src/snapshot-handler";

describe("snapshot command handler", () => {
  it("captures screen and passes result to sidebar attachment", async () => {
    const mockCapture = vi.fn().mockResolvedValue({ success: true, filePath: "C:\\temp\\snap.png" });
    const mockAttach = vi.fn().mockResolvedValue(undefined);
    const mockShowInfo = vi.fn();
    const mockShowError = vi.fn();

    await handleTakeSnapshotCommand({
      captureScreen: mockCapture,
      attachImage: mockAttach,
      showInformationMessage: mockShowInfo,
      showErrorMessage: mockShowError,
    });

    expect(mockCapture).toHaveBeenCalledOnce();
    expect(mockAttach).toHaveBeenCalledWith("C:\\temp\\snap.png");
    expect(mockShowError).not.toHaveBeenCalled();
    expect(mockShowInfo).toHaveBeenCalledWith(expect.stringContaining("attached to chat"));
  });

  it("handles capture error gracefully without attaching", async () => {
    const mockCapture = vi.fn().mockResolvedValue({ success: false, error: "Access denied" });
    const mockAttach = vi.fn();
    const mockShowInfo = vi.fn();
    const mockShowError = vi.fn();

    await handleTakeSnapshotCommand({
      captureScreen: mockCapture,
      attachImage: mockAttach,
      showInformationMessage: mockShowInfo,
      showErrorMessage: mockShowError,
    });

    expect(mockCapture).toHaveBeenCalledOnce();
    expect(mockAttach).not.toHaveBeenCalled();
    expect(mockShowError).toHaveBeenCalledWith(expect.stringContaining("Access denied"));
  });
});
