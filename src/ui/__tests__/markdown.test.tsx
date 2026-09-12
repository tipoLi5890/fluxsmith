// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "../chat/Markdown";

function render(text: string): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  act(() => { createRoot(host).render(<Markdown text={text} />); });
  return host;
}

describe("Markdown renderer", () => {
  it("never emits raw HTML", () => {
    const host = render("hello <script>alert(1)</script> <img src=x onerror=alert(1)> **bold** `code`");
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("<script>alert(1)</script>");
    expect(host.querySelector("strong")?.textContent).toBe("bold");
    expect(host.querySelector("code")?.textContent).toBe("code");
  });
  it("only links http(s) and never javascript:", () => {
    const host = render("[ok](https://example.com) [bad](javascript:alert(1))");
    const links = Array.from(host.querySelectorAll("a"));
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe("https://example.com");
    expect(links[0].getAttribute("rel")).toContain("noopener");
    expect(host.textContent).toContain("[bad](javascript:alert(1))");
  });
  it("renders lists, headings, code fences and tables as elements", () => {
    const host = render("# T\n\n- a\n- b\n\n```\nx < y\n```\n\n| h1 | h2 |\n|---|---|\n| 1 | 2 |");
    expect(host.querySelector("h2")?.textContent).toBe("T");
    expect(host.querySelectorAll("li")).toHaveLength(2);
    expect(host.querySelector("pre code")?.textContent).toBe("x < y");
    expect(host.querySelectorAll("td")).toHaveLength(2);
  });
});
