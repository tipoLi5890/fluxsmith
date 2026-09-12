// SPDX-License-Identifier: Apache-2.0
fn main() {
    embed_common_controls_manifest_in_test_binaries();
    tauri_build::build()
}

/// `tauri-build` embeds the application manifest through
/// `cargo:rustc-link-arg-bins`, which by design never reaches a test harness. So
/// `cargo test -p fluxsmith-app --lib` produces an executable with no manifest,
/// the loader binds the comctl32 5.82 that ships in System32, and that version
/// does not export `TaskDialogIndirect` -- only the side-by-side
/// Microsoft.Windows.Common-Controls 6 does, and a manifest is the only way to
/// ask for it. The process then dies with STATUS_ENTRYPOINT_NOT_FOUND before the
/// first test runs, which the Windows loader states verbatim under loader snaps:
///
///   LdrpReportError - ERROR: Locating export "TaskDialogIndirect" for DLL
///   "...\deps\fluxsmith_app-<hash>.exe" failed with status: 0xc0000139
///
/// The import is not ours -- nothing in `src/` calls TaskDialog -- it arrives
/// through the dialog plugin's dependency chain, so the fix belongs at the link
/// step rather than in the code.
///
/// Test targets only. The bin already carries a manifest resource of its own and
/// a second one merged in at link time would collide.
fn embed_common_controls_manifest_in_test_binaries() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        return;
    }

    const MANIFEST: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls"
                        version="6.0.0.0" processorArchitecture="*"
                        publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
"#;

    let out = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"))
        .join("common-controls-v6.manifest");
    std::fs::write(&out, MANIFEST).expect("write the test manifest");
    println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
    println!(
        "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
        out.display()
    );
    println!(
        "cargo:warning=test binaries get a Common-Controls 6 manifest from {}",
        out.display()
    );
}
