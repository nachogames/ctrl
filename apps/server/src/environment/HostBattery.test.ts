import { describe, expect, it } from "@effect/vitest";

import { parseLinuxBattery, parsePmsetBattery } from "./HostBattery.ts";

describe("parsePmsetBattery", () => {
  it("reads a laptop on battery", () => {
    expect(
      parsePmsetBattery(
        "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=25493603)\t75%; discharging; 20:00 remaining present: true\n",
      ),
    ).toEqual({ percent: 75, pluggedIn: false });
  });

  it("reads a laptop on the charger", () => {
    expect(
      parsePmsetBattery(
        "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n",
      ),
    ).toEqual({ percent: 100, pluggedIn: true });
  });

  it("reports no battery on a desktop Mac or a UPS-only reading", () => {
    expect(parsePmsetBattery("Now drawing from 'AC Power'\n")).toBeNull();
    expect(
      parsePmsetBattery("Now drawing from 'AC Power'\n -CP1500PFCLCD (id=2)\t100%; charged\n"),
    ).toBeNull();
  });
});

describe("parseLinuxBattery", () => {
  it("treats anything but discharging as plugged in", () => {
    expect(parseLinuxBattery({ capacity: "42\n", status: "Discharging\n" })).toEqual({
      percent: 42,
      pluggedIn: false,
    });
    expect(parseLinuxBattery({ capacity: "80\n", status: "Not charging\n" })).toEqual({
      percent: 80,
      pluggedIn: true,
    });
  });

  it("rejects an unreadable capacity", () => {
    expect(parseLinuxBattery({ capacity: "", status: "Full" })).toBeNull();
  });
});
