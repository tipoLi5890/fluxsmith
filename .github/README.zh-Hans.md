# fluxsmith

**给 KiCad 的 AI 主导电路设计工具。** 你在对话里描述电路，agent 提出计划、把它画进真实的
`.kicad_sch`、再检查自己的成果。你是通过核准计划留在回路里，不是通过摆放符号。

**其他语言：** [English](../README.md) · [繁體中文](README.zh-Hant.md) · [日本語](README.ja.md)

> [!WARNING]
> **实验性研究项目，不是产品。** 这里的东西从未在作者以外的机器上跑过。
>
> - 1.0 之前，不保证稳定。格式会无预警改变，版本之间没有升级路径。
> - 它会写入真实的 `.kicad_sch`。请把任何你交给它的项目放进版本控制。
> - 没有人验证过这些电路。不适用于安全关键、医疗、车用或量产用途。
> - 你的电路、对话与 datasheet 会被送到你所选的模型提供商。
> - 与 KiCad 项目无隶属关系，也未获其背书。

## 运作方式

一轮对话就是一次事务，在三种模式之一进行：

| 模式 | agent 能做什么 |
|---|---|
| **Plan** | 读项目、提问、提出计划。tool 表里没有写入 tool。 |
| **Build** | 画进电路图，但只在你已核准的计划范围内。 |
| **Review** | 跑检查、报告 finding。tool 表里没有写入 tool。 |

- 每一轮在第一次写入前建立 checkpoint。**“回到第 n 轮之前”**是唯一的历史操作：线性、无 redo、
  无 per-op undo、画布不能编辑。
- agent 不能回滚，也不能自行切进 Build 模式。
- 越出已核准范围、分裂或合并具名 net、建立或删除 sheet、refdes 冲突、超出本轮预算之前，它会停下来
  问你。一次核准只解锁一个动作。
- 每一个 pass/fail 都来自引擎。agent 与 UI 从不自行判断电路对错。

引擎是 fluxsmith 自己的 Rust 原生 KiCad 原理图读取器、写入器、netlister 与检查器 ——
无 Python、无 subprocess、无 KiCad plugin。KiCad 是 oracle：round-trip 逐 byte 比对、netlist 对照
`kicad-cli sch export netlist`、写出的文件必须通过 `kicad-cli sch erc` 并能在 KiCad GUI 打开。

## 当前状态

| 范围 | 状态 |
|---|---|
| 引擎 | 已实作；`cargo test --workspace` 全绿 |
| KiCad conformance | 逐 byte round-trip、netlist 一致、写后 ERC、重复 apply 幂等；钉在 KiCad 10.0.4 |
| App | Tauri 后端、agent harness、对话、只读画布、设置、零件采购、四种界面语言 |
| 黄金集 | 自然语言题，以确定性图配对评分。最近：加权 0.90（N=3）与 0.86（N=1）；硬停门槛 15，实际 21 未达 |
| Windows | CI 会构建，从未人工跑过 |
| PCB 布局 | 尚未开始 |

目前刻意不做：Altium import、SPICE、MCP server、web UI、画布编辑。

## 运行前提

- **KiCad 10**，由你自行安装。不打包；未安装时 AI 功能停用。
- 一个模型提供商：你自己的 API key，或本地的 OpenAI-compatible 端点。

若要从源码构建，另外需要：

- **Rust** stable，由 `rust-toolchain.toml` 钉版。
- **Node LTS + pnpm** —— 只在构建期需要。出货的 app 没有 Node 运行环境。
- **Xcode Command Line Tools**（macOS 13+）或 **Visual Studio Build Tools + WebView2**（Windows 10/11）。

## 安装

已打标签版本的安装包附在 [Releases](../../../releases) 页：

| 平台 | 文件 |
|---|---|
| macOS（Apple silicon） | `fluxsmith-<version>-macos-arm64.dmg` |
| macOS（Intel） | `fluxsmith-<version>-macos-x64.dmg` |
| Windows 10/11（x64） | `fluxsmith-<version>-windows-x64-setup.exe` |

它们未签名，所以第一次启动会被拦下。这是预期行为，fluxsmith 不会代你绕过它：

- **macOS** —— 打开 `.dmg`，把 fluxsmith 拖进「应用程序」，启动一次，然后在
  系统设置 > 隐私与安全性 > 仍要打开 放行。若 macOS 直接拒绝，改为清掉下载标记：
  `xattr -dr com.apple.quarantine /Applications/fluxsmith.app`。
- **Windows** —— 运行安装包，选「更多信息 > 仍要运行」。它以当前用户身份安装，不会要求管理员权限。

运行之前先用同一个 release 里的 `SHA256SUMS` 核对下载：

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing   # macOS
sha256sum     -c SHA256SUMS --ignore-missing   # 其他平台
```

### 从源码构建

```sh
pnpm install --frozen-lockfile
pnpm tauri dev      # 运行
pnpm tauri build    # 产出 bundle
```

### 首次启动

1. **设置 → Models** —— 选一个提供商并存入 key。内置 Anthropic、OpenAI、Google、OpenRouter、xAI、
   Groq 与 Mistral，也可以登记你自己的 OpenAI-compatible origin。key 由 Rust 写进 app data 目录的
   `secrets.json`（权限 `0600`），永不进入 webview。
2. 在欢迎界面选 **打开示例项目**。它会复制 `examples/ldo_3v3/`，原文件永不被动到。
3. 用四种语言中的任一种要一件小事：“把 C1 接在输入端、C2 接在输出端”。在你进入 Build 之前不会写入
   任何东西。

## 隐私

**使用 fluxsmith 的前提是你的电路内容、对话与 datasheet 会被送到你所选的模型提供商。fluxsmith 不负责
任何隐私与敏感数据。若隐私对你重要，请以自定义 provider 走本地部署模型。**

没有 fluxsmith 服务器、没有账号、没有 telemetry。所有出向 HTTP 都经过 Rust 并受 origin 白名单限制。
对话存在 app data，不在你的项目内。

## 安全

不可信输入 ——`.kicad_sch` 内容、引擎输出、模型输出、skill pack —— 永远不能改变授权状态。webview 不
持有任何长期密钥。强制点在 Rust，不在 prompt 里。细节与漏洞报告方式见 [`SECURITY.md`](../SECURITY.md)。

## Repo 结构

```
crates/       Rust 引擎 —— S-expression 读写、reader、ops、netlist、writer、检查、几何
src-tauri/    Rust 后端 —— typed IPC、授权、密钥、出向 fetch、文件监看、app data
src/          React webview —— agent harness、对话、自绘画布、i18n、设置
skills/       内置 agent skills
tests/        KiCad conformance、黄金集、对抗语料
examples/     随 app 出货的示例项目
scripts/      lint 与黄金集 runner
fuzz/         cargo-fuzz target
```

每个目录都有自己的 README。设计文档不进版本控制，所以源码注释里的 `docs/…` 指向的是不属于本 repo
的笔记。

## 开发

```sh
cargo test --workspace      # 引擎 + 后端
pnpm test                   # harness、画布、UI
pnpm build                  # lint + 类型检查 + bundle
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
cargo deny check licenses
```

- UI 与其字符串一律不用 emoji；勾叉与状态用 Lucide icon，由 lint 强制。
- `src/styles/tokens.css` 的 token 以外不得硬编码颜色。
- 四种界面语言必须保持齐全。
- 新依赖只接受 Apache-2.0、MIT 或 BSD 类。不链接、不打包任何 GPL。

需要真实 KiCad 的 conformance 测试在缺席时跳过。黄金集会花真的钱，因此是手动流程且从不挡 merge ——
见 [`tests/golden-set/README.md`](../tests/golden-set/README.md)。

## 许可

[Apache-2.0](../LICENSE)。第三方组件保留各自的许可，列于 [`NOTICE`](../NOTICE)。

## 致谢

- **KiCad** —— 这个项目能存在的理由，也是它的正确性 oracle。
- **[KiCanvas](https://github.com/theacodes/kicanvas)** 与 eeschema —— 画布绘制惯例的参考。
  没有 vendored；画布是依引擎自己的几何绘制的。
- **[pi](https://github.com/earendil-works/pi)** —— model transport 与 agent loop 机械部分。
- **JLC2KiCadLib**、**jlcparts** 与 **jlcsearch** —— 零件采购的设计参考与服务；转换规则在
  `crates/easyeda-convert` 以 Rust 重新实作。
- 由 **Codex** 与 **Claude Code** 辅助开发。
