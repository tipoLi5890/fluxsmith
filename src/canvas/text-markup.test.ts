// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { textLines, overbar } from "./renderer";

describe("KiCad text markup", () => {
  it("splits multi-line text on real and literal newlines", () => {
    expect(textLines("a\nb")).toEqual(["a", "b"]);
    expect(textLines("a\\nb\\nc")).toEqual(["a", "b", "c"]);
    expect(textLines("plain")).toEqual(["plain"]);
  });
  it("strips ~{} overbar markup and reports the span", () => {
    expect(overbar("~{RESET}")).toEqual({ text: "RESET", from: 0, to: 5 });
    expect(overbar("n~{CS}_A")).toEqual({ text: "nCS_A", from: 1, to: 3 });
    expect(overbar("SDA")).toEqual({ text: "SDA", from: -1, to: -1 });
  });
});
