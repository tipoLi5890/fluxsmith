// SPDX-License-Identifier: Apache-2.0
// Geist Sans / Mono (SIL OFL 1.1): original files vendored unmodified in src/styles/fonts/ (copied from the `geist`
// npm package, whose "exports" map hides them); bundled by Vite, no network.
import sansUrl from "../styles/fonts/Geist-Variable.woff2?url";
import sansItalicUrl from "../styles/fonts/Geist-Italic-Variable.woff2?url";
import monoUrl from "../styles/fonts/GeistMono-Variable.woff2?url";

let installed = false;
export function installFonts(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.setAttribute("data-fluxsmith-fonts", "");
  style.textContent = [
    `@font-face{font-family:"Geist Sans";src:url("${sansUrl}") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}`,
    `@font-face{font-family:"Geist Sans";src:url("${sansItalicUrl}") format("woff2");font-weight:100 900;font-style:italic;font-display:swap}`,
    `@font-face{font-family:"Geist Mono";src:url("${monoUrl}") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}`,
  ].join("\n");
  document.head.appendChild(style);
}
