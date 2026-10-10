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

  it("runs overlapping switches in order so the last request wins", async () => {
    let active = "solid";
    const events: string[] = [];
    let releaseFirstSet!: () => void;
    let firstSetStarted!: () => void;
    const firstSetPending = new Promise<void>((resolve) => {
      firstSetStarted = resolve;
    });
    mocks.native!.getAppIcon.mockImplementation(async () => {
      events.push(`get:${active}`);
      return active;
    });
    mocks.native!.setAppIcon.mockImplementation((design: string) => {
      events.push(`set:${design}`);
      if (design !== "outline") {
        active = design;
        return Promise.resolve();
      }
      firstSetStarted();
      return new Promise<void>((resolve) => {
        releaseFirstSet = () => {
          active = design;
          resolve();
        };
      });
    });
    const { applyLauncherIcon } = await load();

    const first = applyLauncherIcon("outline");
    const second = applyLauncherIcon("mac");
    await firstSetPending;
    expect(events).toEqual(["get:solid", "set:outline"]);
    releaseFirstSet();

    await expect(first).resolves.toBe("applied");
    await expect(second).resolves.toBe("applied");
    expect(events).toEqual(["get:solid", "set:outline", "get:outline", "set:mac"]);
    expect(active).toBe("mac");
  });
});
