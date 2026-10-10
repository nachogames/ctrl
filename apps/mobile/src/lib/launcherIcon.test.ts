import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  native: null as null | {
    getAppIcon: ReturnType<typeof vi.fn>;
    setAppIcon: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("expo", () => ({ requireOptionalNativeModule: () => mocks.native }));

async function load() {
  vi.resetModules();
  return import("./launcherIcon");
}

beforeEach(() => {
  mocks.native = { getAppIcon: vi.fn(), setAppIcon: vi.fn().mockResolvedValue(undefined) };
});

describe("applyLauncherIcon", () => {
  it("does nothing when the native module is missing (web, Expo Go, old dev client)", async () => {
    mocks.native = null;
    const { applyLauncherIcon } = await load();
    await expect(applyLauncherIcon("mac")).resolves.toBe("unavailable");
  });

  it("skips the native setter when the icon is already active", async () => {
    mocks.native!.getAppIcon.mockResolvedValue("solid");
    const { applyLauncherIcon } = await load();
    await expect(applyLauncherIcon("solid")).resolves.toBe("unchanged");
    expect(mocks.native!.setAppIcon).not.toHaveBeenCalled();
  });

  it("switches to a different design", async () => {
    mocks.native!.getAppIcon.mockResolvedValue("solid");
    const { applyLauncherIcon } = await load();
    await expect(applyLauncherIcon("outline")).resolves.toBe("applied");
    expect(mocks.native!.setAppIcon).toHaveBeenCalledWith("outline");
  });
});
