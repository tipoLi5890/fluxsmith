// SPDX-License-Identifier: Apache-2.0
//! Native (pre-webview) dialogs — the one place UI text lives outside the webview
//! (`docs/platform-notes.md` §1.2): the WebView2 runtime check on Windows. Strings come from
//! `src-tauri/i18n/<lang>.json` (four languages, chosen by the OS locale) because the
//! webview catalogue is not available when the webview itself cannot start.

use std::collections::BTreeMap;

const EN: &str = include_str!("../i18n/en.json");
const ZH_HANT: &str = include_str!("../i18n/zh-Hant.json");
const ZH_HANS: &str = include_str!("../i18n/zh-Hans.json");
const JA: &str = include_str!("../i18n/ja.json");

pub const WEBVIEW2_DOWNLOAD_URL: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";

/// `en` | `zh-Hant` | `zh-Hans` | `ja` from a BCP-47-ish locale string.
pub fn lang_of(locale: &str) -> &'static str {
    let l = locale.to_ascii_lowercase().replace('_', "-");
    if l.starts_with("ja") {
        "ja"
    } else if l.starts_with("zh") {
        if l.contains("hans") || l.contains("-cn") || l.contains("-sg") {
            "zh-Hans"
        } else {
            "zh-Hant"
        }
    } else {
        "en"
    }
}

pub fn strings(lang: &str) -> BTreeMap<String, String> {
    let src = match lang {
        "zh-Hant" => ZH_HANT,
        "zh-Hans" => ZH_HANS,
        "ja" => JA,
        _ => EN,
    };
    serde_json::from_str(src).unwrap_or_default()
}

pub fn os_lang() -> &'static str {
    lang_of(&sys_locale::get_locale().unwrap_or_else(|| "en".into()))
}

/// Windows: verify the WebView2 runtime before building the window; on failure show a native
/// dialog (download / quit) and exit. Elsewhere a no-op.
#[cfg(windows)]
pub fn check_webview2() {
    if tauri::webview_version().is_ok() {
        return;
    }
    let s = strings(os_lang());
    let get = |k: &str| s.get(k).cloned().unwrap_or_else(|| k.to_string());
    let choice = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title(get("webview2.title"))
        .set_description(format!(
            "{}\n\n{}",
            get("webview2.missing"),
            get("webview2.next")
        ))
        .set_buttons(rfd::MessageButtons::OkCancelCustom(
            get("webview2.download"),
            get("webview2.quit"),
        ))
        .show();
    if matches!(
        choice,
        rfd::MessageDialogResult::Ok | rfd::MessageDialogResult::Custom(_)
    ) && !matches!(choice, rfd::MessageDialogResult::Cancel)
    {
        // Open the official page in the default browser; `start` is the shell verb, not a tool we depend on.
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", WEBVIEW2_DOWNLOAD_URL])
            .spawn();
    }
    std::process::exit(3);
}

#[cfg(not(windows))]
pub fn check_webview2() {}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn four_catalogues_have_the_same_keys() {
        let en = strings("en");
        assert!(!en.is_empty());
        for l in ["zh-Hant", "zh-Hans", "ja"] {
            let s = strings(l);
            assert_eq!(
                s.keys().collect::<Vec<_>>(),
                en.keys().collect::<Vec<_>>(),
                "{l}"
            );
        }
        assert_eq!(lang_of("zh-TW"), "zh-Hant");
        assert_eq!(lang_of("zh_CN"), "zh-Hans");
        assert_eq!(lang_of("ja-JP"), "ja");
        assert_eq!(lang_of("fr-FR"), "en");
    }
}
