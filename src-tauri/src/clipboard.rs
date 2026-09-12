// SPDX-License-Identifier: Apache-2.0
//! OS clipboard image fallback (`docs/operations-misc.md` clipboard): when the webview's
//! paste event carries no `File` for a copied bitmap (WebView2, some macOS apps), the
//! composer asks Rust for the image through `arboard` and attaches it as PNG.

use crate::error::err;
use crate::ipc::{ClipboardImage, IpcError};
use base64::Engine as _;

/// Longest edge accepted (larger images are still returned; the intake pipeline resizes).
pub const MAX_PIXELS: u64 = 40_000_000;

pub fn read_image() -> Result<Option<ClipboardImage>, IpcError> {
    let mut cb = arboard::Clipboard::new()
        .map_err(|e| err("FS_TRANSIENT", format!("clipboard unavailable: {e}")))?;
    let img = match cb.get_image() {
        Ok(i) => i,
        Err(arboard::Error::ContentNotAvailable) => return Ok(None),
        Err(e) => return Err(err("FS_TRANSIENT", format!("clipboard read failed: {e}"))),
    };
    let (w, h) = (img.width as u32, img.height as u32);
    if (w as u64) * (h as u64) > MAX_PIXELS || w == 0 || h == 0 {
        return Err(err(
            "ATTACH_TOO_LARGE",
            format!("clipboard image {w}x{h} exceeds the limit"),
        ));
    }
    let rgba = image::RgbaImage::from_raw(w, h, img.bytes.into_owned()).ok_or_else(|| {
        err(
            "ATTACH_TYPE_REJECTED",
            "clipboard image has an unexpected layout",
        )
    })?;
    let mut png = Vec::new();
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|e| err("ATTACH_TYPE_REJECTED", format!("png encode failed: {e}")))?;
    Ok(Some(ClipboardImage {
        png_base64: base64::engine::general_purpose::STANDARD.encode(png),
        width: w,
        height: h,
    }))
}
