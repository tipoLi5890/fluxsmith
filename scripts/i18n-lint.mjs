// SPDX-License-Identifier: Apache-2.0
// i18n lint: the Simplified catalogues must not contain Traditional-only characters, Taiwanese IT
// vocabulary or terms that are off the term base (docs/ui-terms.md) — a converted zh-Hant reads as
// machine output to a mainland engineer — and the Traditional catalogues must not contain
// Simplified-only characters. Build fails on a hit.
//
// The character sets list codepoints that exist in exactly one script, so they can never fire on
// legitimate text in the other; shared characters (警 需 量 餐 繁 席 準 沖 靠 面 里 只 系 斗 松 范 谷 …)
// are deliberately excluded. Both sets are checked against the live catalogues: every character here
// is absent from the catalogue it guards.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Every file under `src/i18n/` (any depth) whose basename is `name`: the catalogue and every copy table. */
function i18nFiles(name, dir = "src/i18n") {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...i18nFiles(name, p));
    else if (e === name) out.push(p.split(/[\\/]/).join("/"));
  }
  return out.sort();
}
// Discovered, not listed: a new table under src/i18n/ is linted the day it appears (the error tables
// once sat outside a hand-written list and kept `session` / untranslated `sheet` for a release).
const HANS_FILES = i18nFiles("zh-Hans.ts");
const HANT_FILES = i18nFiles("zh-Hant.ts");

const TRAD_ONLY = [
  "腳採刪檔專設構儲檢載軟訂網螢訊連結輪圖們個這說為與麼於後開關點線電將經進時間問題寫讀請選項紀換決淨潰紋篩",
  "計討論訪許診詞試話該詳誠語誤課調談諒諸諾謀講謝謹識證譯議護變讓讚認",
  "貝負財貢貨貧貪貫責貴買費貼賀資賊賓賜賞賠賣賤賦質賬賭購賽贈贊贏賴",
  "針釘釣鈴鉛銀銅銘銷鋁鋒鋼錄錘錢錦錫錯鍋鍵鍾鎖鏈鏡鐘鐵鑄鑰",
  "車軌軍較輔輕輛輝輩輯輸轉門閃閉閏閒閱闊闖闢飛飯飲飼飽餅養館饋",
  "馬駐駛駕騎騙騰驅驗驚頁頂順須預領頭頸頻額顏願類顧顯顆魚魯鮮鳥鳴鴨鵝鷹",
  "約紅納純紙級細終組結絕統經綠維綱緊緩編緣縣縮總績織繞繪繼續纏罰羅罷糾紐縱繫籤",
  "萬丟並亂亞產親觀覺見規視覽來傳億儘優償兒內兩冊農凍劃劇則剛創劍動務勝勞勢勵勸匯區協單卻厭厲參發叢葉號嘆嗎嚴國團園圓壓墳墊壇壞壘壯聲處備複夠夢夾奧奪獎婦學寧實審寬寵寶對導尋屆層屬島嶺幣帶帥師幫廠廢廣廟廚廳彈歸當彎徑從復徹憶憲應懷懶戀戰戲戶拋捨掃據擇撲擔擁擊擠擬擴攔攜攝擋數斷書會樹機權櫃樣標樓樂橋歐歡歲歷殺殼毀氣氫沒況淚淺渾減測湯溝滅滿漢潑潔潛潤濃濕濟濱灑灣災烏無煉煙熱燈營燒爐爭爺爾牆牽犧狀獨獲獻獸環現畢異療癢皺盜盡監盤瞭確礎礦禍禮種積稱穀穩窮竊競筆節範築簡簽籃籌類糧習聖聞聯聰職聽肅脅脈腦膚膽臉臘臨興舊舉艙艦藝蓋蘋藥蘭蟲蠟蠻術衛襯觸辦辭迴遊運過達違遠適遲遷遺還邁邊邏鄉鄰醜醫釀釋鬥鬧鬱髮體麗麥黃黨齊齒龍龜劉陣陰陳陸陽階隊隨險隱雙雜雞離難雲霧靈靜韓響驟際裡麵隻眾佈併佔傑傷僅價儀側偵華蘇敵敗態憑敘條極殘滯漲澤疊碼礙義裝趕趙趨跡踐躍遞雖飾餘髒鬆譜豐鑑圍塊彙徵懸洩龐",
].join("");

const SIMP_ONLY = [
  "脚删档专设构储检载软订网讯连结轮图们个这说为与么开关点线电将经进时间问题写读请选项换决净溃纹筛",
  "计讨论访许诊词试话该详诚语误课调谈谅诸诺谋讲谢谨识证译议护变让赞认",
  "贝负财贡货贫贪贯责贵买费贴贺资贼宾赐赏赔卖贱赋质账赌购赛赠赢赖",
  "针钉钓铃铅银铜铭销铝锋钢录锤钱锦锡错锅键锁链镜钟铁铸钥",
  "车轨军较辅轻辆辉辈辑输转门闪闭闰阅阔闯辟飞饭饮饲饱饼养馆馈",
  "马驻驶驾骑骗腾驱验惊页顶顺须预领头颈频额颜愿类顾显颗鱼鲁鲜鸟鸣鸭鹅鹰",
  "约红纳纯纸级细终组结绝统经绿维纲紧缓编缘县缩总绩织绕绘继续缠罚罗罢纠纽纵签",
  "万丢乱亚产亲观觉见规视览来传亿尽优偿儿内两册农冻剧则刚创剑动务胜劳势励劝汇区协单却厌厉参发丛叶号叹吗严国团园圆压坟垫坛坏垒壮声处备复够梦夹奥夺奖妇学宁实审宽宠宝对导寻届层属岛岭币带帅师帮厂废广庙厨厅弹归当弯径从彻忆宪应怀懒恋战戏抛舍扫据择扑担拥击挤拟扩拦携摄挡数断书会树机权柜样标楼乐桥欧欢岁历杀壳毁气氢没况泪浅浑减测汤沟灭满汉泼洁潜润浓湿济滨洒湾灾乌无炼烟热灯营烧炉争爷尔墙牵牺状独获献兽环现毕异疗痒皱盗尽监盘确础矿祸礼种积称稳穷窃竞笔节筑简篮筹类粮习圣闻联聪职听肃胁脉脑肤胆脸腊临兴旧举舱舰艺盖苹药兰虫蜡蛮术卫衬触办辞游运过达违远适迟迁遗还迈边逻乡邻医酿释闹发体丽麦黄党齿龙龟刘阵阴陈陆阳阶队随险隐双杂鸡离难雾灵静韩响骤际众伤仅价仪侧侦华苏敌败态凭条极残滞涨泽叠码碍义装赶赵趋迹践跃递虽饰脏谱鉴围块征悬庞",
].join("");

// Taiwanese IT vocabulary and terms off the term base (docs/ui-terms.md), with the mainland form.
// 分页 (pagination) and 资料 (reference material) exist in Simplified but never with those senses in
// this UI; if a genuine use appears, narrow the entry rather than dropping the rule. 网路 is not
// here: its rewrite depends on what the English says (`network` -> 网络, `net` -> keep `net`), so it
// is checked against the English source below, with the finding and error tables.
const TAIWAN_WORDS = [
  ["专案", "项目"], ["设定", "设置"], ["快取", "缓存"], ["建构", "构建"], ["储存", "保存"],
  ["检视", "查看"], ["套用", "应用"], ["载入", "加载"], ["软体", "软件"], ["硬体", "硬件"],
  ["自订", "自定义"], ["透过", "通过"], ["使用者", "用户"], ["程式", "程序"],
  ["视窗", "窗口"], ["讯息", "消息"], ["滑鼠", "鼠标"], ["萤幕", "屏幕"], ["纪录", "记录"],
  ["资料", "数据"], ["资讯", "信息"], ["介面", "界面"], ["伺服器", "服务器"], ["连结", "链接"],
  ["影片", "视频"], ["品质", "质量"], ["效能", "性能"], ["列印", "打印"], ["解析度", "分辨率"],
  ["计画", "计划"], ["核准", "批准"], ["呼叫", "调用"], ["预设", "默认"], ["搜寻", "搜索"],
  ["汇出", "导出"], ["汇入", "导入"], ["贴上", "粘贴"], ["相容", "兼容"], ["点选", "点击"],
  ["登入", "登录"], ["分页", "标签页"], ["侦测", "检测"], ["在背景", "在后台"],
  ["复写", "覆写"], ["回退", "回滚"], ["数据夹", "文件夹"],
];

// 档 renders "file" only in Taiwanese usage (原理图档 / 压缩档 / 档案); mainland keeps it for 文档 and 归档.
const DANG_ALLOWED = ["文档", "归档"];

function strings(file) {
  const src = readFileSync(file, "utf8").split("\n");
  const out = [];
  src.forEach((line, i) => {
    if (line.trimStart().startsWith("//")) return;
    for (const m of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) out.push({ file, line: i + 1, text: m[1] });
  });
  return out;
}

let bad = 0;
const fail = (where, msg) => { console.error(`${where}: ${msg}`); bad++; };

for (const f of HANS_FILES) {
  for (const { file, line, text } of strings(f)) {
    const where = `${file}:${line}`;
    for (const [w, right] of TAIWAN_WORDS) if (text.includes(w)) fail(where, `Taiwanese/off-term-base "${w}" (use "${right}")`);
    for (const c of TRAD_ONLY) if (text.includes(c)) fail(where, `Traditional character "${c}"`);
    let rest = text;
    for (const ok of DANG_ALLOWED) rest = rest.split(ok).join("");
    if (rest.includes("档")) fail(where, `"档" as "file" (use "文件"; only 文档 / 归档 are allowed)`);
  }
}
for (const f of HANT_FILES) {
  for (const { file, line, text } of strings(f)) {
    for (const c of SIMP_ONLY) if (text.includes(c)) fail(`${file}:${line}`, `Simplified character "${c}"`);
  }
}

// --------------------------------------------------------------- key parity
// The four catalogues are one key set. `tsc` catches a key missing from a catalogue (Catalogue is
// Record<MessageKey, string>) but not one that is only in a translation, and it says nothing about
// the error tables; both are caught here, before the type-check, with the file and line.
const UI_LANGS = ["en", "zh-Hant", "zh-Hans", "ja"];
const ENTRY = /^\s*"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/;
const ERROR_ROW = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*\[(.*)\]\s*,?\s*$/;

/** `key -> {value, line}` of a catalogue file (one entry per line, as the catalogues are written). */
function catalogue(file) {
  const out = new Map();
  readFileSync(file, "utf8").split("\n").forEach((l, i) => {
    if (!/^\s*"/.test(l)) return;
    const m = ENTRY.exec(l);
    if (!m) { fail(`${file}:${i + 1}`, `catalogue entry the lint cannot read (one "key": "value" per line)`); return; }
    if (out.has(m[1])) fail(`${file}:${i + 1}`, `duplicate key "${m[1]}"`);
    out.set(m[1], { value: m[2], line: i + 1 });
  });
  return out;
}

/**
 * `CODE -> {parts, line}` of a three-part copy table (`CODE: ["a", "b", "c"],`): the error tables
 * (`title, why, next`) and the finding tables (`title, detail, remedy`) are written the same way.
 */
function copyTable(file, what, parts) {
  const out = new Map();
  readFileSync(file, "utf8").split("\n").forEach((l, i) => {
    if (!/^\s*[A-Z][A-Z0-9_]*\s*:/.test(l)) return;
    const m = ERROR_ROW.exec(l);
    if (!m) { fail(`${file}:${i + 1}`, `${what} row the lint cannot read (one CODE: [${parts.join(", ")}] per line)`); return; }
    out.set(m[1], { parts: [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((s) => s[1]), line: i + 1 });
  });
  return out;
}
const ERROR_PARTS = ["title", "why", "next"];
const FINDING_PARTS = ["title", "detail", "remedy"];

const cats = Object.fromEntries(UI_LANGS.map((l) => [l, catalogue(`src/i18n/${l}.ts`)]));
const errs = Object.fromEntries(UI_LANGS.map((l) => [l, copyTable(`src/i18n/errors/${l}.ts`, "error copy", ERROR_PARTS)]));
const finds = Object.fromEntries(UI_LANGS.map((l) => [l, copyTable(`src/i18n/findings/${l}.ts`, "finding copy", FINDING_PARTS)]));
/** Every copy table, by directory, so the per-language rules below run over all of them alike. */
const TABLES = { errors: errs, findings: finds };
// A table this lint does not know is a table nothing checks: every `src/i18n/<dir>/en.ts` must be
// one of TABLES, and every table must have its four languages on disk.
for (const f of i18nFiles("en.ts")) {
  const dir = f.split(/[\\/]/).slice(2, -1).join("/");
  if (dir && !TABLES[dir]) fail(f, `copy table "${dir}" is not registered in i18n-lint.mjs (TABLES), so nothing lints it`);
}
for (const dir of Object.keys(TABLES)) for (const l of UI_LANGS) if (!i18nFiles(`${l}.ts`).includes(`src/i18n/${dir}/${l}.ts`)) fail(`src/i18n/${dir}/${l}.ts`, "missing language file");

for (const l of UI_LANGS.filter((x) => x !== "en")) {
  for (const k of cats.en.keys()) if (!cats[l].has(k)) fail(`src/i18n/${l}.ts`, `missing key "${k}"`);
  for (const k of cats[l].keys()) if (!cats.en.has(k)) fail(`src/i18n/${l}.ts:${cats[l].get(k).line}`, `key "${k}" is not in en.ts`);
  for (const c of errs.en.keys()) if (!errs[l].has(c)) fail(`src/i18n/errors/${l}.ts`, `missing error copy for ${c}`);
  for (const c of errs[l].keys()) if (!errs.en.has(c)) fail(`src/i18n/errors/${l}.ts:${errs[l].get(c).line}`, `error copy for ${c} is not in en.ts`);
  for (const c of finds.en.keys()) if (!finds[l].has(c)) fail(`src/i18n/findings/${l}.ts`, `missing finding copy for ${c}`);
  for (const c of finds[l].keys()) if (!finds.en.has(c)) fail(`src/i18n/findings/${l}.ts:${finds[l].get(c).line}`, `finding copy for ${c} is not in en.ts`);
}
// Every code the copy tables carry must be declared, and every declared code must have copy.
const declared = new Set([...readFileSync("src/i18n/errors/codes.ts", "utf8").matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]));
for (const c of declared) if (!errs.en.has(c)) fail("src/i18n/errors/en.ts", `ERROR_CODES declares ${c} but there is no copy for it`);
for (const c of errs.en.keys()) if (!declared.has(c)) fail("src/i18n/errors/codes.ts", `${c} has copy but is not in ERROR_CODES`);
// Same both ways for the finding registry: `FINDING_FAMILY` in `src/agent/finding-codes.ts` is the
// code list of record (one `CODE: "family",` per line), and every code in it must have copy.
const findingCodes = new Set([...readFileSync("src/agent/finding-codes.ts", "utf8").matchAll(/^\s*([A-Z][A-Z0-9_]+):\s*"/gm)].map((m) => m[1]));
for (const c of findingCodes) if (!finds.en.has(c)) fail("src/i18n/findings/en.ts", `FINDING_FAMILY declares ${c} but there is no copy for it`);
for (const c of finds.en.keys()) if (!findingCodes.has(c)) fail("src/agent/finding-codes.ts", `${c} has copy but is not in FINDING_FAMILY`);

// ---------------------------------------------------- dynamic key families
// Keys built at runtime from a literal union of `src/agent/api.ts` (`t(\`card.kind.${kind}\`)` and
// friends): the type-checker only sees the cast, so a member added to the union without its four
// catalogue entries would reach the UI as a raw key. Every member of each union must have its key.
const api = readFileSync("src/agent/api.ts", "utf8");
const FAMILIES = [
  ["CardKind", "card.kind."],
  ["Role", "settings.models.role."],
  ["Phase", "phase."],
];
for (const [type, prefix] of FAMILIES) {
  const m = new RegExp(`export type ${type} =([^;]*);`).exec(api);
  if (!m) { fail("src/agent/api.ts", `cannot find "export type ${type}" (the i18n lint reads its members)`); continue; }
  const members = [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  if (!members.length) { fail("src/agent/api.ts", `type ${type} has no string members to check`); continue; }
  for (const v of members) for (const l of UI_LANGS) if (!cats[l].has(prefix + v)) fail(`src/i18n/${l}.ts`, `missing "${prefix}${v}" (${type} member "${v}")`);
}

// ------------------------------------------------------ untranslated values
// A translated value byte-identical to the English one, with Latin letters left in it once the
// `{placeholders}` are removed, is almost always a line nobody translated. The exceptions are real:
// product names, retained technical terms (the term base keeps `net` untranslated), acronyms, units
// and identifiers. Those are listed here — one line per reason — so adding one is a decision.
const SAME_AS_EN_OK = new Set([
  "app.name",            // the product name
  "common.ok",           // ja uses "OK"
  "side.col.net",        // ui-terms.md: `net` is never translated in a circuit context
  "canvas.status.net",   // hover readout: the `Net` prefix is the same in all four languages
  "canvas.status.cursor", // "mil" is the unit
  "side.attachKind.netlist", // the `net` family again (zh keeps "netlist")
  "intake.kind.netlist",
  "side.attachKind.bom", // acronyms
  "settings.agent.intake.bom",
  "intake.kind.bom",
  "settings.agent.intake.pdf",
  "card.parts_decision.field.lcsc",
  "error.reqId",         // `req_id` is the field name, shown verbatim
  "side.confidence.kicad", // the product name plus an acronym, exactly as `side.findingsKicad` keeps it
]);
const bare = (s) => s.replace(/\{\w+\}/g, "");
for (const l of UI_LANGS.filter((x) => x !== "en")) {
  for (const [k, { value }] of cats.en) {
    const t = cats[l].get(k);
    if (!t || t.value !== value || !/[A-Za-z]/.test(bare(value)) || SAME_AS_EN_OK.has(k)) continue;
    fail(`src/i18n/${l}.ts:${t.line}`, `"${k}" is still the English value (allow-list it in i18n-lint.mjs if that is intended)`);
  }
  for (const [c, { parts }] of errs.en) {
    const t = errs[l].get(c);
    if (!t) continue;
    parts.forEach((p, i) => {
      if (p && t.parts[i] === p && /[A-Za-z]/.test(bare(p))) fail(`src/i18n/errors/${l}.ts:${t.line}`, `${c}[${ERROR_PARTS[i]}] is still the English copy`);
    });
  }
  for (const [c, { parts }] of finds.en) {
    const t = finds[l].get(c);
    if (!t) continue;
    parts.forEach((p, i) => {
      if (p && t.parts[i] === p && /[A-Za-z]/.test(bare(p))) fail(`src/i18n/findings/${l}.ts:${t.line}`, `${c}[${FINDING_PARTS[i]}] is still the English copy`);
    });
  }
}

// ------------------------------------------------------------- banned terms
// docs/ui-terms.md 禁用字: internal vocabulary a human must never read. `session` and `envelope`
// name machinery (a BuildSession, an approval scope) that the UI states in its own words; 快照 is
// not a checkpoint (the term base says 本輪備份); 硬停 is what the code calls the stop, while the
// card says 停下來問你; and `sheet` left in a Chinese value is a line nobody translated (圖頁 /
// 图页). `{placeholders}` are stripped first -- `{sheet}` is a value, not a word -- and `datasheet`
// keeps its `sheet`. Undo / Redo are deliberately absent: `/redo <step>` is a command name and
// `plan.redo` re-runs a skipped plan step; the ban is on undo/redo of edits, which no key offers.
const SNAPSHOT_OK = new Set([
  "settings.skills.l0Usage",        // the L0 text as it stands, not a checkpoint
  "system.pre_rollback_restored",   // the pre-rollback copy of the files a rollback overwrote
  "recovery.note.rollback_interrupted", // the same pre-rollback copy, named by the recovery note
  "rollback.externalWarn",
  "rollback.willRemove",
  "rollback.snapshotNote",
  "card.parts_decision.intro",      // the parts catalogue's own snapshot of a field
  "settings.project.exportBomHint", // LCSC catalogue data as it was fetched
]);
// A value that keeps the Latin word on purpose (a pinned readout the four languages share) goes here.
const SHEET_OK = new Set([]);
const BANNED = [
  { re: /\bsessions?\b/i, langs: UI_LANGS, why: '"session" is internal (docs/ui-terms.md): name the thing — Build, or a conversation' },
  { re: /セッション/, langs: ["ja"], why: "「セッション」は内部語: 構築 / 会話 と書く" },
  { re: /工作階段|工作阶段/, langs: ["zh-Hant", "zh-Hans"], why: "工作階段 is \"session\": say 建構 / 對話" },
  { re: /\benvelopes?\b/i, langs: ["en"], why: '"envelope" is internal: the UI word is "scope"' },
  { re: /硬停/, langs: ["zh-Hant", "zh-Hans"], why: "硬停 is internal: the card says 停下來問你 / 停下来问你" },
  { re: /快照/, langs: ["zh-Hant", "zh-Hans"], allow: SNAPSHOT_OK, why: "快照 must not mean checkpoint (term base: 本輪備份 / 本轮备份); allow-list a genuine snapshot in i18n-lint.mjs" },
  { re: /(?<!data)sheets?\b/i, langs: ["zh-Hant", "zh-Hans"], allow: SHEET_OK, why: "sheet is 圖頁 / 图页 in the term base" },
];
const noPlaceholders = (s) => s.replace(/\{\w+\}/g, "");

/**
 * Every value of one language with its English counterpart: the catalogue (`id` = key, allow-lists
 * apply) and each copy table (`id` = CODE; codes carry no allow-list entries, every rule applies as
 * written). The error and finding copy is UI text too — the same words are banned there.
 */
function* valuesOf(l) {
  for (const [k, { value, line }] of cats[l]) yield { where: `src/i18n/${l}.ts:${line}`, id: k, key: k, value, en: cats.en.get(k)?.value ?? "" };
  for (const [dir, table] of Object.entries(TABLES)) {
    for (const [code, { parts, line }] of table[l]) {
      const enParts = table.en.get(code)?.parts ?? [];
      for (const [i, p] of parts.entries()) if (p) yield { where: `src/i18n/${dir}/${l}.ts:${line}`, id: code, key: null, value: p, en: enParts[i] ?? "" };
    }
  }
}
for (const l of UI_LANGS) {
  for (const { where, id, key, value } of valuesOf(l)) {
    for (const rule of BANNED) {
      if (!rule.langs.includes(l) || (key !== null && rule.allow?.has(key))) continue;
      if (rule.re.test(noPlaceholders(value))) fail(where, `${key !== null ? `"${id}"` : id}: ${rule.why}`);
    }
  }
}

// ------------------------------------------------------- 網路 is not `net`
// The term base keeps `net` untranslated in a circuit context (docs/ui-terms.md 禁用字: 網路（指
// net）). 網路 / 网络 is right only in the sense of "network" — proxy, offline, the request that
// timed out — so a value is judged against its English source: `network` there makes it legitimate,
// `net` / `nets` there makes it the banned sense. The compounds that can only ever mean net are
// banned outright, whatever the source says. In zh-Hans, 网路 is also the Taiwanese spelling of
// "network", so it is always wrong there; which rewrite it gets depends on the same source.
const NET_COMPOUND = /(?:網路|网路|网络|網絡)(?:標籤|标签|名稱|名称|合併|合并|拆分|連通|连通|保護|保护|推導|推导|清單|清单)|具名(?:網路|网路|网络|網絡)/;
const saysNet = (en) => /\bnets?\b/i.test(en) && !/\bnetwork/i.test(en);
for (const l of ["zh-Hant", "zh-Hans"]) {
  for (const { where, id, value, en } of valuesOf(l)) {
    const v = noPlaceholders(value);
    if (NET_COMPOUND.test(v)) { fail(where, `${id}: 網路 means net here (term base: \`net\` stays untranslated — 具名 net, net 名稱, net label)`); continue; }
    const hasNetwork = /網路|网路|网络|網絡/.test(v);
    if (hasNetwork && saysNet(en)) fail(where, `${id}: the English says "net", so 網路 / 网络 is the banned sense (keep \`net\`); only "network" copy may say 網路 / 网络`);
    if (l === "zh-Hans" && /网路/.test(v) && !saysNet(en)) fail(where, `${id}: Taiwanese/off-term-base "网路" (use "网络")`);
  }
}

// --------------------------------------------------------------- unused keys
// A key nothing in `src/**` asks for is copy nobody reads: it survives translation rounds, screenshot
// walks and term-base sweeps for nothing. A key counts as used when a source file spells it
// (`t("side.nets")`) or when it starts with the static part of a template key (`t(`card.kind.${x}`)`
// covers that whole family). The catalogues and the error tables are not sources: they define keys.
function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(p) && !/i18n[\\/](en|ja|zh-Hant|zh-Hans)\.ts$/.test(p) && !/i18n[\\/]errors[\\/]/.test(p)) out.push(p);
  }
  return out;
}
const spelled = new Set();
const families = new Set();
for (const f of sourceFiles("src")) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/["'`]([A-Za-z0-9_.]+)["'`]/g)) spelled.add(m[1]);
  for (const m of src.matchAll(/`([A-Za-z0-9_.]*)\$\{/g)) if (m[1].includes(".")) families.add(m[1]);
}
const familyList = [...families];
for (const [k, { line }] of cats.en) {
  if (spelled.has(k) || familyList.some((p) => k.startsWith(p))) continue;
  fail(`src/i18n/en.ts:${line}`, `"${k}" is not used anywhere in src/** (delete it from all four catalogues, or use it)`);
}

if (bad) { console.error(`i18n-lint: ${bad} problem(s)`); process.exit(1); }
console.log("i18n-lint: ok (character sets, vocabulary, key parity, dynamic families, untranslated values, banned terms, unused keys)");
