import { describe, expect, it } from "vite-plus/test";

import { projectScriptTerminalId, scriptIdFromTerminalId } from "./projectScripts.ts";

describe("script terminal ids", () => {
  it("maps script, setup and settle terminals back to their script", () => {
    expect(scriptIdFromTerminalId(projectScriptTerminalId("dev-server"))).toBe("dev-server");
    expect(scriptIdFromTerminalId("setup-install")).toBe("install");
    expect(scriptIdFromTerminalId("settle-clean-up-0a1b2c3d")).toBe("clean-up");
  });

  it("finds no script behind other terminals", () => {
    expect(scriptIdFromTerminalId("term-1")).toBeNull();
    expect(scriptIdFromTerminalId("script-")).toBeNull();
    expect(scriptIdFromTerminalId("settle-clean")).toBeNull();
  });
});
