// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { parseMicroEdit } from "../turns/state";

describe("parseMicroEdit", () => {
  it("accepts terse and CJK phrasings", () => {
    expect(parseMicroEdit("C2 value = 10u", [])).toEqual({ reference: "C2", field: "value", value: "10u" });
    expect(parseMicroEdit("請幫我把 C2 換成 10u", [])).toEqual({ reference: "C2", field: "value", value: "10u" });
    expect(parseMicroEdit("将 R1 改为 4.7k", [])).toEqual({ reference: "R1", field: "value", value: "4.7k" });
    expect(parseMicroEdit("C1 を 100nF にして", [])).toEqual({ reference: "C1", field: "value", value: "100nF" });
  });
  it("rejects anything that is more than a value change", () => {
    expect(parseMicroEdit("把 C2 換成 10u 並且移到 U1 旁邊", [])).toBeNull();
    expect(parseMicroEdit("C2 是什麼", [])).toBeNull();
    expect(parseMicroEdit("加一顆 100n 在 U1 旁", [])).toBeNull();
  });
});
