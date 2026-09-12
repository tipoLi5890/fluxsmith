# fluxsmith

**給 KiCad 的 AI 主導電路設計工具。** 你在對話裡描述電路，agent 提出計畫、把它畫進真實的
`.kicad_sch`、再檢查自己的成果。你是透過核准計畫留在迴路裡，不是透過擺放符號。

**其他語言：** [English](../README.md) · [简体中文](README.zh-Hans.md) · [日本語](README.ja.md)

> [!WARNING]
> **實驗性研究專案，不是產品。** 這裡的東西從未在作者以外的機器上跑過。
>
> - 1.0 之前，不保證穩定。格式會無預警改變，版本之間沒有升級路徑。
> - 它會寫入真實的 `.kicad_sch`。請把任何你交給它的專案放進版本控制。
> - 沒有人驗證過這些電路。不適用於安全關鍵、醫療、車用或量產用途。
> - 你的電路、對話與 datasheet 會被送到你所選的模型提供商。
> - 與 KiCad 專案無隸屬關係，也未獲其背書。

## 運作方式

一輪對話就是一次交易，在三種模式之一進行：

| 模式 | agent 能做什麼 |
|---|---|
| **Plan** | 讀專案、問問題、提出計畫。tool 表裡沒有寫入 tool。 |
| **Build** | 畫進電路圖，但只在你已核准的計畫範圍內。 |
| **Review** | 跑檢查、報告 finding。tool 表裡沒有寫入 tool。 |

- 每一輪在第一次寫入前建立 checkpoint。**「回到第 n 輪之前」**是唯一的歷史操作：線性、無 redo、
  無 per-op undo、畫布不能編輯。
- agent 不能回滾，也不能自行切進 Build 模式。
- 越出已核准範圍、分裂或合併具名 net、建立或刪除 sheet、refdes 衝突、超出本輪預算之前，它會停下來
  問你。一次核准只解鎖一個動作。
- 每一個 pass/fail 都來自引擎。agent 與 UI 從不自行判斷電路對錯。

引擎是 fluxsmith 自己的 Rust 原生 KiCad schematic 讀取器、寫入器、netlister 與檢查器 ——
無 Python、無 subprocess、無 KiCad plugin。KiCad 是 oracle：round-trip 逐 byte 比對、netlist 對照
`kicad-cli sch export netlist`、寫出的檔案必須通過 `kicad-cli sch erc` 並能在 KiCad GUI 開啟。

## 目前狀態

| 範圍 | 狀態 |
|---|---|
| 引擎 | 已實作；`cargo test --workspace` 全綠 |
| KiCad conformance | 逐 byte round-trip、netlist 一致、寫後 ERC、重複 apply 冪等；釘在 KiCad 10.0.4 |
| App | Tauri 後端、agent harness、對話、唯讀畫布、設定、零件採購、四種介面語言 |
| 黃金集 | 自然語言題，以確定性圖配對評分。最近：加權 0.90（N=3）與 0.86（N=1）；硬停門檻 15，實際 21 未達 |
| Windows | CI 會建置，從未人工跑過 |
| PCB 佈局 | 尚未開始 |

目前刻意不做：Altium import、SPICE、MCP server、web UI、畫布編輯。

## 執行前提

- **KiCad 10**，由你自行安裝。不打包；未安裝時 AI 功能停用。
- 一個模型提供商：你自己的 API key，或本地的 OpenAI-compatible 端點。

若要從原始碼建置，另外需要：

- **Rust** stable，由 `rust-toolchain.toml` 釘版。
- **Node LTS + pnpm** —— 只在建置期需要。出貨的 app 沒有 Node 執行環境。
- **Xcode Command Line Tools**（macOS 13+）或 **Visual Studio Build Tools + WebView2**（Windows 10/11）。

## 安裝

已標記版本的安裝檔附在 [Releases](../../../releases) 頁：

| 平台 | 檔案 |
|---|---|
| macOS（Apple silicon） | `fluxsmith-<version>-macos-arm64.dmg` |
| macOS（Intel） | `fluxsmith-<version>-macos-x64.dmg` |
| Windows 10/11（x64） | `fluxsmith-<version>-windows-x64-setup.exe` |

它們未簽章，所以第一次啟動會被攔下。這是預期行為，fluxsmith 不會代你繞過它：

- **macOS** —— 開啟 `.dmg`，把 fluxsmith 拖進「應用程式」，啟動一次，然後在
  系統設定 > 隱私與安全性 > 仍要打開 放行。若 macOS 直接拒絕，改為清掉下載標記：
  `xattr -dr com.apple.quarantine /Applications/fluxsmith.app`。
- **Windows** —— 執行安裝檔，選「其他資訊 > 仍要執行」。它以目前使用者身分安裝，不會要求管理員權限。

執行之前先用同一個 release 裡的 `SHA256SUMS` 核對下載：

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing   # macOS
sha256sum     -c SHA256SUMS --ignore-missing   # 其他平台
```

### 從原始碼建置

```sh
pnpm install --frozen-lockfile
pnpm tauri dev      # 執行
pnpm tauri build    # 產出 bundle
```

### 首次啟動

1. **設定 → Models** —— 選一個提供商並存入 key。內建 Anthropic、OpenAI、Google、OpenRouter、xAI、
   Groq 與 Mistral，也可以登記你自己的 OpenAI-compatible origin。key 由 Rust 寫進 app data 目錄的
   `secrets.json`（權限 `0600`），永不進入 webview。
2. 在歡迎畫面選 **開啟範例專案**。它會複製 `examples/ldo_3v3/`，原檔永不被動到。
3. 用四種語言中的任一種要一件小事：「把 C1 接在輸入端、C2 接在輸出端」。在你進入 Build 之前不會寫入
   任何東西。

## 隱私

**使用 fluxsmith 的前提是你的電路內容、對話與 datasheet 會被送到你所選的模型提供商。fluxsmith 不負責
任何隱私與機敏資料。若隱私對你重要，請以自訂 provider 走本地部署模型。**

沒有 fluxsmith 伺服器、沒有帳號、沒有 telemetry。所有出向 HTTP 都經過 Rust 並受 origin 白名單限制。
對話存在 app data，不在你的專案內。

## 安全

不可信輸入 ——`.kicad_sch` 內容、引擎輸出、模型輸出、skill pack —— 永遠不能改變授權狀態。webview 不
持有任何長期密鑰。強制點在 Rust，不在 prompt 裡。細節與漏洞回報方式見 [`SECURITY.md`](../SECURITY.md)。

## Repo 結構

```
crates/       Rust 引擎 —— S-expression 讀寫、reader、ops、netlist、writer、檢查、幾何
src-tauri/    Rust 後端 —— typed IPC、授權、密鑰、出向 fetch、檔案監看、app data
src/          React webview —— agent harness、對話、自繪畫布、i18n、設定
skills/       內建 agent skills
tests/        KiCad conformance、黃金集、對抗語料
examples/     隨 app 出貨的範例專案
scripts/      lint 與黃金集 runner
fuzz/         cargo-fuzz target
```

每個目錄都有自己的 README。設計文件不進版本控制，所以原始碼註解裡的 `docs/…` 指向的是不屬於本 repo
的筆記。

## 開發

```sh
cargo test --workspace      # 引擎 + 後端
pnpm test                   # harness、畫布、UI
pnpm build                  # lint + 型別檢查 + bundle
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
cargo deny check licenses
```

- UI 與其字串一律不用 emoji；勾叉與狀態用 Lucide icon，由 lint 強制。
- `src/styles/tokens.css` 的 token 以外不得硬編碼顏色。
- 四種介面語言必須維持齊全。
- 新相依只接受 Apache-2.0、MIT 或 BSD 類。不連結、不打包任何 GPL。

需要真實 KiCad 的 conformance 測試在缺席時跳過。黃金集會花真的錢，因此是手動流程且從不擋 merge ——
見 [`tests/golden-set/README.md`](../tests/golden-set/README.md)。

## 授權

[Apache-2.0](../LICENSE)。第三方元件保留各自的授權，列於 [`NOTICE`](../NOTICE)。

## 致謝

- **KiCad** —— 這個專案能存在的理由，也是它的正確性 oracle。
- **[KiCanvas](https://github.com/theacodes/kicanvas)** 與 eeschema —— 畫布繪製慣例的參考。
  沒有 vendored；畫布是依引擎自己的幾何繪製的。
- **[pi](https://github.com/earendil-works/pi)** —— model transport 與 agent loop 機械部分。
- **JLC2KiCadLib**、**jlcparts** 與 **jlcsearch** —— 零件採購的設計參考與服務；轉換規則在
  `crates/easyeda-convert` 以 Rust 重新實作。
- 由 **Codex** 與 **Claude Code** 輔助開發。
