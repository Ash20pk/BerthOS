import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { demuxLogBuffer, parseBootId, parsePolicyLines, parseRulesetReports } from "./attest.js";

function frame(stream: number, text: string): Buffer {
  const payload = Buffer.from(text, "utf-8");
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

describe("demuxLogBuffer", () => {
  it("strips 8-byte frame headers from a multiplexed log buffer", () => {
    const buf = Buffer.concat([frame(2, "[berth:entrypoint] boot id: abc\n"), frame(1, "hello\n")]);
    assert.equal(demuxLogBuffer(buf), "[berth:entrypoint] boot id: abc\nhello\n");
  });

  it("passes an unframed (TTY) buffer through untouched", () => {
    const text = "plain text logs\nwith lines\n";
    assert.equal(demuxLogBuffer(Buffer.from(text)), text);
  });
});

describe("parseBootId", () => {
  it("takes the newest boot id line, so a restarted container attests its current boot", () => {
    const logs = "[berth:entrypoint] boot id: old-boot\nother\n[berth:entrypoint] boot id: new-boot\n";
    assert.equal(parseBootId(logs), "new-boot");
  });

  it("returns undefined when no boot id was ever logged", () => {
    assert.equal(parseBootId("no berth here\n"), undefined);
  });
});

describe("parseRulesetReports", () => {
  const applied = (app: string, bootId: string, ruleset = "FullyEnforced") =>
    JSON.stringify({ source: "agent-init", event: "capability_policy_applied", bootId, app, ruleset, timestamp: 5 });

  it("collects capability_policy_applied events for the given boot only", () => {
    const logs = [applied("a", "boot-1"), applied("stale", "boot-0"), "not json {", applied("b", "boot-1", "NotEnforced")].join("\n");
    const reports = parseRulesetReports(logs, "boot-1");
    assert.deepEqual(reports, [
      { app: "a", ruleset: "FullyEnforced", bootId: "boot-1", timestamp: 5 },
      { app: "b", ruleset: "NotEnforced", bootId: "boot-1", timestamp: 5 },
    ]);
  });

  it("ignores other agent-init events", () => {
    const logs = JSON.stringify({ source: "agent-init", event: "capabilities_dropped", bootId: "boot-1", app: "a" });
    assert.deepEqual(parseRulesetReports(logs, "boot-1"), []);
  });
});

describe("parsePolicyLines", () => {
  it("parses '<sha256> <app> <path>' lines and skips noise", () => {
    const hash = "d".repeat(64);
    const output = `${hash} demo /app/.berth/capability-policy.json\ngarbage line\n`;
    assert.deepEqual(parsePolicyLines(output), [{ sha256: hash, app: "demo", path: "/app/.berth/capability-policy.json" }]);
  });
});
