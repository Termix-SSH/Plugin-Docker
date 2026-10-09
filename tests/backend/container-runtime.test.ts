import { describe, expect, it } from "vitest";
import { containerCommand } from "../../src/backend/container-runtime.js";

describe("containerCommand", () => {
  it("extends PATH on POSIX hosts", () => {
    const command = containerCommand("podman", "ps");
    expect(command.startsWith('PATH="')).toBe(true);
    expect(command.endsWith(" podman ps")).toBe(true);
  });

  it("runs the plain CLI on Windows hosts", () => {
    expect(containerCommand("docker", "ps -a", true)).toBe("docker ps -a");
  });

  it("falls back to docker for an unknown runtime", () => {
    expect(containerCommand(undefined, "ps", true)).toBe("docker ps");
  });
});
