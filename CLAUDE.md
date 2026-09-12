# CLAUDE.md

fluxsmith — 私有（尚未決定是否公開）的 Tauri 桌面 app：**給不裝 Claude Code 的 KiCad 工程師的
AI 主導的電路設計工具**——人在右側對話裡與 agent 討論並切換 Plan / Build / Review 模式，agent 在 Build 內自主把電路畫進
真實 `.kicad_sch`；每一輪對話是一個可整輪回滾的交易，越界或危險動作才硬停問人。引擎是 **fluxsmith 自己的 Rust 原生 KiCad schematic 引擎**
（`crates/`）。**fluxsmith 是獨立專案**：一份先前的 Python KiCad CLI（以下稱**參考實作**；不在本 repo、不公開）只是設計方向的參考（它逆向出的 eeschema 規則、踩過的坑、
skills/採購/facts 的設計思路），**不是相依、不是相容目標、不修改它、不為它調整功能**；正確性的 oracle 是 KiCad 本身
（`kicad-cli`、GUI 可開）。

文件索引：`docs/pcb-architecture.md`（第二套流程：PCB 佈局，P0-P4，排在原理圖 M2 之後）、`docs/SPEC.md`（產品規格 0.5：AI 主導、Plan/Build/Review 模式、輪次回滾；產品層單一真相源）、`docs/agent-runtime.md`（模式、輪次、Lead/subagents、tool 目錄、硬停、內建 workflow）、`docs/opspec-v1.md`、`docs/identity.md`（凍結）、`docs/error-codes.md`、`docs/project-config.md`、`docs/workspace-format.md`、`docs/tool-manifest.md`、`docs/ui-states.md`、`docs/ui-terms.md`、`skills/`、`tests/golden-set/`、`docs/proposal.md`（定位、里程碑、中止線）、`docs/engine-architecture.md`（引擎 crate 與
不變量）、`docs/engine-conformance.md`（以 KiCad 為 oracle 的 parity 測試，merge 門檻）、
`docs/agent-architecture.md`（harness：tools / skills / workflows / hooks / grant）、`docs/harness-strategy.md`（loop 路線與借鑑）、`docs/caching-strategy.md`（prompt cache 版面）、`docs/build-from-source.md`、`docs/chat-references-and-attachments.md`（@ 指涉、附件、私有庫、圖片）、`docs/skill-packs.md`（使用者 skill 擴充）、`docs/message-stream-ux.md`（訊息流相位 UX）、`docs/context-compaction.md`（context 圓環與壓縮）、`docs/design-system.md`（黑白灰 token、字體、元件、亮暗主題）、`docs/settings.md`（設定頁面）、`docs/crash-recovery.md`、`docs/testing-strategy.md`、`docs/updates-and-compatibility.md`、`docs/ci.md`、`docs/logging.md`、`docs/release-process.md`（含 About 與「永遠不會」清單）、`docs/platform-notes.md`、`docs/provider-resilience.md`（含離線矩陣）、`docs/operations-misc.md`（換機器 / 效能預算 / 說明系統 / 在地化 / 黃金集維護 / 指標 / 成本報表 / 剪貼簿 / 快捷鍵）、`docs/spikes.md`、
`SECURITY.md`、`docs/going-public.md`（公開前檢查表：已完成項目＋只有作者能做的 GitHub 設定）、`docs/reviews/`（審查與研究紀錄）。

## 目前狀態

**E0–E4 與 M0–M5 實作已落地，M6 部分（2026-08-30）**：引擎 crates + `fluxsmith-cli`（`cargo test --workspace`，含 I1–I25 `inv_` 與 `reg_` 測試、
`fuzz/`、`tests/conformance/ops.v1.schema.json` 漂移檢查）、Tauri 後端（`src-tauri/`：崩潰復原 `recovery.rs`、M3 的 web/pdf/facts/bom 工具）、
harness 與 UI（`src/`，`pnpm test`、`pnpm build`、`pnpm tauri build`）。顯示層為自繪畫布（S-C1 定案，不 vendor KiCanvas）；
loop 採 B 路線（pi-agent-core 打包進 webview，S-P1 通過）。真模型黃金集最近紀錄為加權 0.90（N=3，2026-08-30；硬停 21，未達 ≤ 15）與 0.86（N=1，2026-09-03）；
N=3 中止線量測、workflow runner（M4）、L5 重播／L6 注入語料、UI 文案收尾仍在進行；PCB（`docs/pcb-architecture.md`）未開始。目標平台：macOS + Windows（Linux 列入「若之後」）。**KiCad 10 是使用者必須自行安裝的執行期前提**（D-51：未安裝進 `EnvIncomplete`，AI 功能停用並引導環境設定；不 bundle KiCad 庫）。
**以原始碼啟動是正式支援的散布方式**（`docs/build-from-source.md`）；私有期只用長期自簽憑證維持 keyring 身分，不宣稱通過 Gatekeeper/SmartScreen。

## 架構紅線（已定案，勿重新討論）

### 引擎

1. **fluxsmith 擁有自己的 op-list 詞彙（opspec v1）**：以參考實作的 22 core + 10 macro 為起點但自由演進（例如
   `set_component_attributes`、sheet pin ops 直接是正式 op）；`protocol_version` 由 fluxsmith 定義並版本化。**UUIDv5 seed
   規則由 fluxsmith 定義並凍結**——改任何 seed 格式會讓既有檔案全部節點重新識別、re-apply 整份複製，屬 major 變更且必須附
   遷移器。不追求與參考實作的 op-list 或輸出 bytes 相容。
2. **無損 S-expression**：未觸碰節點 byte-identical 序列化、未知節點原樣保留、單一 quoter、無原生
   遞迴、深度/大小上限回結構化錯誤不 panic。
3. **座標一律整數 nm；變換順序 rotate-then-mirror；檔案角度 `+90 → (y,−x)`**；reader / writer /
   geom 共用同一 `transform` 函式，禁止各自實作。
4. **eeschema 方言為準**：無 `(junction)` 的 mid-span T 不連通；local label 同 sheet 與同名
   global/power 合併、跨 sheet 不合併；`PWR_FLAG` 不命名；net id 用 membership hash；命名走
   driver-priority ladder。
5. **唯一寫入路徑 = `sch-write` 的 atomic/txn**（temp 同目錄、fsync、`.bak` 輪替、多檔兩階段）；
   `~<name>.lck` 存在拒寫；apply 前以目標檔 sha256 快照比對（TOCTOU）。第一版不提供 `--allow-open` 等價選項。
6. **寫入閘 = 九項 integrity + net-diff `strict_nets`**；閘與 netbuild 共用連通函式。harness / UI
   **不得自判電路正確性**，任何 pass/fail 只能來自 `sch-check` / `sch-net`。
7. **KiCad 是 oracle，parity 是 merge 門檻**：round-trip 逐 byte、netlist 與 `kicad-cli sch export netlist` 一致、寫後
   `kicad-cli sch erc` 無 annotation error、KiCad GUI 可開、apply-twice 冪等（`docs/engine-conformance.md`）；parity 未全綠前
   `Apply` 不得出現在 app UI。參考實作的 fixture/golden 只是可選的額外測試資料，不作判準。
8. **執行期無 Python、無 subprocess 到任何外部 CLI、無 FFI**。`kicad-cli` 在執行期只做可選的 advisory 二次驗證
   （缺席非致命；不加 `--exit-code-violations`、不加 `--`）；在測試期是 conformance 判準。
9. **不引入 `kiutils_kicad` 當依賴**（alpha），只讀原始碼參考。**顯示層 = 自繪畫布**（S-C1 定案：不 vendor KiCanvas）：
   `sch-geom::render_sheet` 產生 typed geometry（每點經同一 `transform`），`src/canvas/` 在 Canvas 2D 上繪製、hit-test、選取與高亮；
   繪製規則參考 KiCanvas/eeschema。**任何判定（netlist、DRC、envelope）不依賴畫布**，它只是顯示。
10. **明確不做（第一版）**：Altium import、ngspice sim、review 啟發式、calc、webui、MCP server、KiCad IPC API
    （eeschema 沒有 API）。零件採購（JLC/LCSC 搜尋 + EasyEDA → KiCad 庫轉換）排 **M3**，以 Sourcer agent 實作（設計參考該實作的 `jlc`
    家族與上游 JLC2KiCadLib 的流程）；`.kicad_mod`/`.kicad_sym` writer 自寫，**不得引入 GPL 的 KicadModTree**；轉換結果是
    CLAIM 不是事實，必須對照 datasheet 驗證。

### Harness 與 app

11. **Tauri 後端是 Rust，沒有 Node 執行環境**；不包 Node/Bun sidecar。**以 Pi 為主架構**（`docs/harness-strategy.md` v1.1）：
    `pi-ai` 為 model transport、`pi-agent-core` 為 Lead loop 機械部分——它是 TS 套件，**直接 import 並以 Vite 打包進 webview**；
    S-P1 只驗證其在無 Node 環境可建置與執行（官方建議 `streamProxy()` 是因為他們把密鑰放伺服器，不是技術限制）；不過則退回 pi-ai + 自寫 loop；`pi-coding-agent` 只借設計不整包用；Rust + `rig-core` 為備選（S-P2，只在 webview 路線失敗時啟動）。
    不論如何：pi 型別集中 `pi-adapter.ts` 精確 pin、政策 hook 用自己的 `Hook` 介面包住 pi 的 hook、Rust 仍是強制點、紅線 12 維持。
    不整包採用 grok-build / deepseek-harness / Goose / Codex（皆只能跨行程或需 Node；見 harness-strategy §1）；不論結果，pi 型別集中在 `pi-adapter.ts` 並精確 pin，政策 hook
    不直接依賴 pi 的 hook 型別。不用 `pi-coding-agent`（Node/終端機綁定）。安全強制點在 Rust 與 hook P0-P12，與 loop 來源無關。
12. **所有出向 HTTP 經 Rust `net_fetch`**：前端覆寫 `globalThis.fetch` 只攔 provider origin 轉 Rust
    reqwest（streaming channel），其餘 origin 直接拒絕、不 fallback 到瀏覽器 fetch；白名單 = 內建 enum + **使用者在設定登記的
    自訂 provider origin**（本地部署 / OpenAI-compatible；登記需同意卡；無 TLS 只允許 localhost）；**provider 原生的伺服器端
    工具（web search / web fetch / grounding）在 provider 端執行，不經 app 的網路，能力驅動地暴露為 `web.*` tool**（紅線 21 的
    untrusted 封套適用其結果）；Authorization
    由 Rust 從 keyring 注入，**token 永不進 webview**。CSP `connect-src` 只留防呆，真正白名單是 Rust
    側的 origin enum。
13. **寫入只在 Build 模式、只由 Lead agent、只在已核准的計畫/micro-plan envelope 內**：Plan/Review 模式的 tool 表
    結構上沒有任何 D tool（寫設計檔）；進入 Build 是人類 consent（Rust 側 BuildSession token）；越出 envelope、具名 net SPLIT/MERGE、
    結構破壞、refdes 衝突、integrity ERROR 自修兩次仍在、預算耗盡、外部變更——**硬停**（hook deny + 對話卡片），核准是
    單次 consent 只解鎖一個動作。硬停清單凍結於 `docs/agent-runtime.md` §1。**核准政策 Ask / Review / Auto**（§1b）決定何時出卡：
    Ask 每次 apply 出變更卡；Review（預設）只在硬停出卡；Auto 不出卡但硬停改為自動裁決（可自解者自解、不可者靜默略過該 step
    並記入摘要；需已核准 plan；預算與環境類仍停）——Auto 是「不問」不是「無限授權」，plan envelope 與累計器在 Rust 仍強制。**每輪第一次寫入前必有 checkpoint；「回到第 n 輪
    之前」是唯一的人類回溯操作**（唯一例外：Auto 政策下 Rust 內部 `AutoRevert` 把進行中的 step 回到本輪 checkpoint，不暴露 command）（線性、無 redo、無 per-op undo、無畫布編輯）。agent 不可呼叫 rollback、不可自行切入 Build。
    **範圍永遠有一個不是模型產生的上界**（已核准 plan step 或 Rust 凍結的 session ceiling），所有數量判定以本輪 checkpoint 為基準
    累計；核准狀態只採信 app data，不採信專案目錄；Rust 側持有 envelope、累計器與模式做第二道檢查。tool tier 五級 R/C/D/S/H。
14. **typed request 主權**：webview 對引擎只能送封閉 `EngineRequest` enum，不能送任意路徑；所有路徑
    經 project root canonicalize，**含 op-list `sheets` envelope 宣告的每個檔案**。
15. **tier 提升規則**：實際 tier = max(宣告 tier, 任何模型可填參數所隱含的 tier)。
16. **訂閱制 OAuth 登入是非官方、非支援的可選路徑**（瀏覽器 PKCE 為預設、Device Code 為備援；實作在
    `src/agent/codex-oauth.ts` 與 `src-tauri/src/net.rs`）：交換與輪詢都在 Rust，token 只進密鑰儲存、永不進 webview；
    **任何啟用路徑前面都要有風險同意畫面，即使內部私有使用也不能省略**，同意要資料化（版本 + 時間戳）並作為寫入該
    provider 密鑰的前置條件。**API key 永遠是主線。** 這條路徑**不得出現在任何對外文件中**——不描述為功能、不推薦、
    不作可用性宣稱、不引用任何廠商表態或條款解讀為正當性依據（2026-09-12 作者決定）。不 import Pi 的 oauth 模組。
17. **密鑰一律由 Rust 存在 app data 的 `secrets.json`（0600、原子寫入），不用 OS keychain**（2026-08-28 作者決定：keychain 對未簽章／
    原始碼建置每次重建都跳提示，且對使用者不透明；做法同 pi 的 `auth.json`）；`pi-ai` 的 `CredentialStore` 在前端實作但委派 Rust；
    **密鑰永不進 webview、不進專案目錄、不得被 template 進 workflow YAML**；`keyring_*` command 名稱保留作為介面名。
18. **不可信字串的渲染**：畫布由 `src/canvas/` 在 Canvas 2D 上繪製，不產生 DOM、不用 innerHTML，文字只經 `fillText`；
    webview 不解析原始 `.kicad_sch` 文字（只收引擎的 geometry JSON）；ChatPanel 的 LLM markdown、引擎錯誤字串、疊層文字一律不進
    `innerHTML`/`dangerouslySetInnerHTML`。不再有 SVG 字串進 webview。
19. **不開入向埠**：不提供任何長駐、可被本機其他程序當 API 的服務埠；Rust↔webview 一律 Tauri IPC。**唯一例外**：互動式
    OAuth 登入期間在 `127.0.0.1:1455` 開的一次性回呼（≤ 5 分鐘、只收一個帶正確 `state` 的請求、登入結束即關）。
    出向連線不在此限。fluxsmith 永遠只當 MCP client（若之後做），不當 server。
20. **hook 只能是 in-process TypeScript 純函式**，不得是使用者可設定的 shell 指令；政策 P0-P12 是程式碼不是 prompt。
    使用者擴充走 **skill pack**（`SKILL.md` + `workflow.yaml` + `references/`）。workflow 載入期靜態規則：含 D tool 必須
    `mode: build`；`structural` step 前必有 `approval`；`gate` 判決來源必須是引擎結果欄位；`agent` step 的 tools 不含 D；含 D 的 workflow 必宣告 `limits`；`mode: build` 的 workflow 需與 skill 信任分離的第二次 consent。
21. **`.kicad_sch` 內容、引擎輸出、skill pack 文字皆為不可信輸入**，tool result 標註 untrusted，不得
    改變授權狀態。
22. **不修改參考實作、不向它提功能需求、不為 fluxsmith 調整它**。它是參考，不是上游；fluxsmith 需要的能力一律在
    自己的引擎與 harness 實作。可以借它的設計思路與（MIT）測試資料，不沿用它的契約、格式或程式碼。

## Prompt cache（成本紅線）

`docs/caching-strategy.md` 的不變式是程式碼審查項：穩定在前變動在後；tools/system 逐 byte 確定性（無時間戳/隨機 id/條件段）；
BuildSession 內 tool 表凍結（question 輪由 hook + Rust 拒絕 D，不改表）；模式/政策/plan/`sch.summary` 不進 system；歷史只追加、
只在 compaction 邊界改寫；平行 subagent 先等第一個開始串流；每次呼叫記錄快取欄位，命中率 0 是 bug。

## 語言

使用者可用母語（繁中）提問；**skills、system prompt、subagent brief、tool 描述、內部推理、tool 結果、程式碼註解一律英文**；
只有對使用者的回覆與 UI 文案跟隨使用者語言。**介面語言四種：zh-Hant / zh-Hans / en / ja**（皆正式支援，i18n lint 四語齊全；預設依 OS locale）；回覆語言依本輪訊息判定（假名→ja、繁/簡專屬字集多數決、否則 UI 語言）。

## 隱私免責

使用本軟體的前提是電路內容、對話與 datasheet 會經過所選模型提供商；本軟體不負責任何隱私與機敏資料；有隱私需求以本地部署
模型（自訂 provider）為主。此段文字必須出現在 README、SECURITY 與 provider 設定畫面。

## 視覺

**紅線 23：整個系統 UI 禁止任何 emoji**——字串常數、卡片、徽章、通知、`turn.status`、錯誤文案、匯出報告、log 摘要皆不得含 emoji 或 dingbat 勾叉（`✓ ✗ ✔ ✘ ☑`）；勾叉與狀態一律 Lucide icon；allowlist 只有 `© ® ™`（denylist 明列 Dingbats / Misc Symbols / Geometric Shapes / Misc Technical 區段）；build-time lint 掃 `src/**`、`i18n/**` 與 `docs/**`，命中即 build fail（使用者輸入與檔案內容原樣顯示除外）；icon 只用 Lucide（ISC，vendored，`src/ui/icons.ts` 單一對映表）；AI 相位動效用 `thinking-orbs`（MIT，vendored、pin；對映 `src/ui/orb-state.ts`）。文件中的 UI 範例也不用 emoji，以 `[icon-name]` 標記。設計系統：**直白 / 簡約 / 好學習**，純黑白灰（Geist token 結構）、語意色只用於狀態、亮/暗/system 三主題只透過 token（lint 禁硬編碼色）、Geist Sans/Mono（OFL）+ CJK 系統字型（`docs/design-system.md`）。

## 授權

repo 採 **Apache-2.0**（`LICENSE` + `NOTICE`）。新增相依只接受 Apache-2.0 / MIT / BSD 類相容授權；vendored 第三方（Geist 字型、Lucide）保留原授權並登記於 `NOTICE`；thinking orb 為自製實作；pi-* 為 pnpm 精確 pin 的 npm 相依；
**不得引入 GPL/LGPL 程式碼或連結**（GPL 工具如 `kicad-cli`、freerouting 只能以使用者自裝的獨立子行程呼叫）。新原始碼檔案檔頭放 SPDX 標記 `SPDX-License-Identifier: Apache-2.0`。

## 文件與 README 的存放規則

- **`docs/`（全部規格、研究、審查紀錄）不進 git**：已在 `.gitignore`；它們只存在本機工作樹。備份方式由作者自理（建議在 `docs/` 內另 `git init` 一個私有 repo，父 repo 因 gitignore 不會看到它）。本檔的文件索引指的是本機路徑；不要把 docs 內容搬進會被追蹤的檔案。
- **README 多語**：根目錄 `README.md` 為英文；`.github/README.zh-Hant.md`、`README.zh-Hans.md`、`README.ja.md` 為對應語言，四份內容同步（改一份要改四份）；隱私免責四份都要有；README 不連結 `docs/`（GitHub 上看不到）。
- 進 git 的只有：程式碼與各目錄 README、`skills/`、`tests/`（含黃金集與語料）、`examples/`、`CLAUDE.md`、`SECURITY.md`、`CHANGELOG.md`、`LICENSE`、`NOTICE`。
- 原始碼註解可以引用 `docs/…`（那是本機設計筆記），但**對外 README 與 SECURITY.md 不得引用**，公開後會是死連結。

## 這是公開的實驗性研究專案（2026-09-12 起）

repo 已公開，但**定位仍是研究專案，不是產品**：沒有發行版、沒有預建二進位、沒有相容性承諾。
- **README 寫法照一般開源專案慣例**（2026-09-12 作者回饋：原本寫得像設計文件）：名稱＋一句話 → 警告 →
  運作方式 → 狀態 → 前提 → 安裝 → 隱私／安全 → 結構 → 開發 → 授權 → 致謝。**一個 bullet 一行一件事、
  不寫散文、不放 ToC**（GitHub 會自己產生大綱）、多用表格與程式碼區塊、不加 badge 牆。四份同步、
  結構逐節對齊（目前各 10 個 h2、6 條警告、2 個表格、3 個程式碼區塊、0 個站內錨點），長度約 140 行。
- **README 開頭的實驗性聲明是紅線**：四份前面的 `> [!WARNING]` 區塊五條（1.0 前不保證穩定／會寫入
  真實檔案／電路未經人驗證、不適用量產／資料外送／與 KiCad 無隸屬關係）不得淡化或移除——可以壓縮字數，
  不可以少一條。**成本那條已於 2026-09-12 依作者指示移除，不要加回去**（開發文件裡「黃金集會花錢」的
  說明留著，那是給開發者的，不是對使用者的警告）。README 結尾的「由 Codex 與 Claude Code 輔助開發」
  一行同樣保留，且保持一行。
- **仍然不主動加**：CONTRIBUTING.md、issue/PR templates、行銷化文案、Linux 支援、badge 牆。
  這些列在 `docs/proposal.md`，等使用者要求才做。
- **release 打包已實作**（`.github/workflows/release.yml`，2026-09-12 使用者要求）：tag `v*` → 產出
  `fluxsmith-<ver>-macos-arm64.dmg` / `-macos-x64.dmg` / `-windows-x64-setup.exe` + `SHA256SUMS` +
  `CHANGELOG-<ver>.md`（命名依 `docs/release-process.md` §4），並開一個 **draft prerelease**——
  **人工按 Publish 才公開，永遠不自動發佈**；`workflow_dispatch` 只留 workflow artifact、不開 release。
  約束：**只能用 GitHub-hosted runner**（self-hosted 不得參與 release，紅線見下）；bundle **未簽章**，
  Gatekeeper / SmartScreen 攔截是預期行為，放行步驟寫在 release notes，**app 內不做任何繞過**
  （`docs/platform-notes.md` §1.5 / §2.3）；preflight 擋版本四面不一致與缺 `## [ver]` CHANGELOG 段；
  tag 同時觸發 `ci.yml` 全套測試，**publish 前必須確認該 tag 的 ci run 全綠**（release 是草稿，人是閘）。
- **安裝路徑有兩條**（2026-09-12 起）：Releases 的安裝檔，或從原始碼建置。README 的 `Install` 段要與
  `release.yml` 寫進 release notes 的內容一致（三個檔名、未簽章的首次啟動放行步驟、`SHA256SUMS` 核對；
  核對指令 macOS 用 `shasum -a 256`、其他平台用 `sha256sum`）。**不得再宣稱「只支援從原始碼安裝」。**
- **對外文件一律英文**：`README.md`（＋三份翻譯）、`SECURITY.md`、`CHANGELOG.md`、各目錄 README。
- **去識別化的範圍是「追蹤檔案的內容」**：不得出現作者本名、email、其他個人 repo 的連結，或
  `/Users/<name>/…` 這類絕對路徑（測試用外部 fixture 一律走 `FLUXSMITH_EXTRA_FIXTURES`）。
  `NOTICE` 的著作權署名是 `The fluxsmith Authors`。
- **commit 作者刻意是作者的 GitHub 身分**：`tipoLi5890 <tipo5890Li@gmail.com>`（2026-09-12 作者決定，
  repo-local git config 已設）。**不要把它改回匿名** —— 這是有意讓 commit 歸屬到該帳號，與上一條不衝突。
- **公開 repo + self-hosted runner**：`conformance` / `golden-nightly` job 只能在本 repo 的分支、
  push-to-main、schedule 或 workflow_dispatch 上跑，**永遠不得對 fork 的 PR 執行**。
