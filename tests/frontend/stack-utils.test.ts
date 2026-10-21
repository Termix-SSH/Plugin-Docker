import { describe, expect, it } from "vitest";
import { parseEnv, serializeEnv } from "../../src/frontend/stacks/stack-utils";
import { stacksEnabledForHost } from "../../src/frontend/types";

describe("env helpers", () => {
  it("keeps comments and blank lines through a round trip", () => {
    const text = "# db\nUSER=admin\n\nexport PASS=a=b\n";
    expect(serializeEnv(parseEnv(text))).toBe(text.replace("export ", ""));
  });

  it("drops rows with no name when saving", () => {
    expect(
      serializeEnv([
        { kind: "kv", key: "", value: "x" },
        { kind: "kv", key: "A", value: "1" },
      ]),
    ).toBe("A=1\n");
  });

  it("returns an empty file for no lines", () => {
    expect(parseEnv("")).toEqual([]);
    expect(serializeEnv([])).toBe("");
  });
});

describe("stacksEnabledForHost", () => {
  const host = (docker: Record<string, unknown>) => ({
    pluginSettings: { docker },
  });

  it("needs docker and stacks on for the host", () => {
    expect(stacksEnabledForHost(host({ enableDocker: true }))).toBe(false);
    expect(stacksEnabledForHost(host({ enableStacks: true }))).toBe(false);
    expect(
      stacksEnabledForHost(host({ enableDocker: true, enableStacks: true })),
    ).toBe(true);
    expect(stacksEnabledForHost(null)).toBe(false);
  });
});
