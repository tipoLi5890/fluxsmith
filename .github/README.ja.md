# fluxsmith

**KiCad のための AI 主導の回路設計ツール。** チャットで回路を説明すると、エージェントが計画を立て、
実在する `.kicad_sch` に描き込み、自分の仕事を点検します。あなたはシンボルを配置するのではなく、
計画を承認することでループに残ります。

**他の言語：** [English](../README.md) · [繁體中文](README.zh-Hant.md) · [简体中文](README.zh-Hans.md)

> [!WARNING]
> **実験的な研究プロジェクトであり、製品ではありません。** 作者のマシン以外で動かしたことはありません。
>
> - 1.0 前で不安定です。形式は予告なく変わり、バージョン間の移行手段はありません。
> - 実在する `.kicad_sch` に書き込みます。渡すプロジェクトは必ずバージョン管理下に置いてください。
> - 回路を検証した人間はいません。安全上重要な用途、医療、車載、量産には適しません。
> - 回路、会話、データシートは、あなたが選んだモデルプロバイダーに送られます。
> - KiCad プロジェクトとは関係がなく、推奨も受けていません。

## 仕組み

会話 1 ターンが 1 トランザクションで、3 つのモードのいずれかで動きます。

| モード | エージェントにできること |
|---|---|
| **Plan** | プロジェクトを読む、質問する、計画を提案する。ツール表に書き込みツールはありません。 |
| **Build** | 回路図に描き込む。ただし承認済み計画の範囲内のみ。 |
| **Review** | チェックを走らせ、finding を報告する。ツール表に書き込みツールはありません。 |

- 各ターンは最初の書き込み前に checkpoint を取ります。**「第 n ターンの前に戻る」**が唯一の履歴操作で、
  線形・redo なし・op 単位の undo なし・キャンバス編集なしです。
- エージェントはロールバックできず、自分で Build モードに入ることもできません。
- 承認済み範囲を越える、名前のあるネットを分割・併合する、シートを作成・削除する、リファレンス指定子が
  衝突する、ターン予算を超える —— いずれの前でも止まって尋ねます。承認 1 回で 1 アクションだけです。
- pass / fail はすべてエンジンから来ます。エージェントと UI が回路の正しさを判定することはありません。

エンジンは fluxsmith 自身の Rust ネイティブな KiCad 回路図リーダー、ライター、ネットリスター、
チェッカーです。Python も、サブプロセスも、KiCad プラグインもありません。オラクルは KiCad 自身で、
ラウンドトリップはバイト単位、ネットリストは `kicad-cli sch export netlist` と突き合わせ、書き出した
ファイルは `kicad-cli sch erc` を通り KiCad GUI で開けなければなりません。

## 現状

| 領域 | 状態 |
|---|---|
| エンジン | 実装済み。`cargo test --workspace` はグリーン |
| KiCad conformance | バイト単位のラウンドトリップ、ネットリスト一致、書き込み後 ERC、再適用の冪等性。KiCad 10.0.4 に固定 |
| アプリ | Tauri バックエンド、エージェントハーネス、チャット、読み取り専用キャンバス、設定、部品調達、UI 4 言語 |
| ゴールデンセット | 自然言語の課題を決定的なグラフ照合で採点。直近は加重 0.90（N=3）と 0.86（N=1）。ハードストップの基準 15 に対し 21 で未達 |
| Windows | CI でビルドのみ。手動で動かしたことはありません |
| PCB レイアウト | 未着手 |

現時点で意図的にやらないこと：Altium インポート、SPICE、MCP サーバー、Web UI、キャンバス上の編集。

## 必要なもの

- **KiCad 10**（自分でインストール）。同梱しません。無い場合 AI 機能は停止します。
- モデルプロバイダー：自分の API キー、またはローカルの OpenAI 互換エンドポイント。

ソースからビルドする場合は、さらに：

- **Rust** stable（`rust-toolchain.toml` で固定）。
- **Node LTS + pnpm** —— ビルド時のみ。出荷されるアプリに Node ランタイムはありません。
- **Xcode Command Line Tools**（macOS 13+）または **Visual Studio Build Tools + WebView2**（Windows 10/11）。

## インストール

タグ付きバージョンのインストーラは [Releases](../../../releases) ページに添付されています。

| プラットフォーム | ファイル |
|---|---|
| macOS（Apple シリコン） | `fluxsmith-<version>-macos-arm64.dmg` |
| macOS（Intel） | `fluxsmith-<version>-macos-x64.dmg` |
| Windows 10/11（x64） | `fluxsmith-<version>-windows-x64-setup.exe` |

いずれも署名されていないため、初回起動はブロックされます。これは想定内で、fluxsmith が勝手に
回避することはしません。

- **macOS** —— `.dmg` を開いて fluxsmith をアプリケーションにドラッグし、一度起動してから
  システム設定 > プライバシーとセキュリティ > このまま開く で許可します。
- **Windows** —— インストーラを実行し、詳細情報 > 実行 を選びます。現在のユーザーにインストール
  するので、管理者の確認は出ません。

実行する前に、同じリリースの `SHA256SUMS` と照合してください。

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing   # macOS
sha256sum     -c SHA256SUMS --ignore-missing   # その他
```

### ソースからビルド

```sh
pnpm install --frozen-lockfile
pnpm tauri dev      # 起動
pnpm tauri build    # bundle を生成
```

### 初回起動

1. **設定 → Models** —— プロバイダーを選びキーを保存します。Anthropic、OpenAI、Google、OpenRouter、
   xAI、Groq、Mistral が組み込みで、自分の OpenAI 互換 origin も登録できます。キーは Rust が
   アプリデータディレクトリの `secrets.json`（パーミッション `0600`）に書き込み、webview には入りません。
2. ウェルカム画面で **サンプルプロジェクトを開く**。`examples/ldo_3v3/` を複製するので、元のファイルは
   触られません。
3. 4 言語のいずれかで小さな依頼をしてみてください。「C1 を入力側に、C2 を出力側に配線して」。
   Build に入るまで何も書き込まれません。

## プライバシー

**fluxsmith を使うということは、回路の内容、会話、データシートが、あなたの選んだモデルプロバイダーに
送られるということです。fluxsmith はプライバシーや機密データについて一切責任を負いません。
プライバシーが重要なら、カスタムプロバイダー経由でローカル配備のモデルを使ってください。**

fluxsmith のサーバーもアカウントもテレメトリもありません。外向き HTTP はすべて Rust を通り、origin
許可リストで制限されます。会話はプロジェクト内ではなくアプリデータに保存されます。

## セキュリティ

信頼できない入力 ——`.kicad_sch` の内容、エンジンの出力、モデルの出力、skill pack —— が権限状態を
変えることは決してできません。webview は長期のシークレットを持ちません。強制点はプロンプトではなく
Rust にあります。詳細と脆弱性の報告方法は [`SECURITY.md`](../SECURITY.md) にあります。

## リポジトリ構成

```
crates/       Rust エンジン —— S-expression 入出力、リーダー、ops、ネットリスト、ライター、チェック、ジオメトリ
src-tauri/    Rust バックエンド —— typed IPC、権限、シークレット、外向き fetch、ファイル監視、アプリデータ
src/          React webview —— エージェントハーネス、チャット、自前描画キャンバス、i18n、設定
skills/       組み込みエージェント skills
tests/        KiCad conformance、ゴールデンセット、敵対的コーパス
examples/     アプリに同梱するサンプルプロジェクト
scripts/      lint とゴールデンセットの runner
fuzz/         cargo-fuzz ターゲット
```

各ディレクトリに README があります。設計文書はバージョン管理外なので、ソースコメントの `docs/…` は
このリポジトリに含まれないノートを指しています。

## 開発

```sh
cargo test --workspace      # エンジン + バックエンド
pnpm test                   # ハーネス、キャンバス、UI
pnpm build                  # lint + 型チェック + bundle
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
cargo deny check licenses
```

- UI とその文字列に emoji は使いません。チェックマークや状態は Lucide のアイコンで、lint が強制します。
- `src/styles/tokens.css` のトークン以外で色をハードコードしないこと。
- UI 4 言語は常に揃っていること。
- 新しい依存は Apache-2.0、MIT、BSD 系のみ。GPL はリンクも同梱もしません。

実機の KiCad を要する conformance テストは、無ければスキップします。ゴールデンセットは費用が発生する
ため手動運用で、マージを止めることはありません。[`tests/golden-set/README.md`](../tests/golden-set/README.md) を参照。

## ライセンス

[Apache-2.0](../LICENSE)。サードパーティ製の構成要素はそれぞれのライセンスを保持し、
[`NOTICE`](../NOTICE) に記載しています。

## 謝辞

- **KiCad** —— このプロジェクトが成立する理由であり、その正しさのオラクル。
- **[KiCanvas](https://github.com/theacodes/kicanvas)** と eeschema —— キャンバス描画の慣習の参考。
  同梱はしておらず、キャンバスはエンジン自身のジオメトリから描いています。
- **[pi](https://github.com/earendil-works/pi)** —— モデルトランスポートとエージェントループの機構。
- **JLC2KiCadLib**、**jlcparts**、**jlcsearch** —— 部品調達の設計参考とサービス。変換規則は
  `crates/easyeda-convert` に Rust で再実装しています。
- 開発は **Codex** と **Claude Code** の支援を受けています。
