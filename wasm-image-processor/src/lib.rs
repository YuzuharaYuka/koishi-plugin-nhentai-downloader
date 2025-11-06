// src/lib.rs
// 主入口模块 - 重导出所有公共 API

use wasm_bindgen::prelude::*;

#[cfg(feature = "console_error_panic_hook")]
pub use console_error_panic_hook::set_once as set_panic_hook;

// 模块声明
mod format;
mod image;
mod anti_censorship;
mod batch;

// ============================================================================
// WASM 初始化
// ============================================================================

/// Initialize the WASM module
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

// ============================================================================
// 图片转换与处理 (WASM 导出)
// ============================================================================

/// Convert any image format to JPEG with specified quality
/// This is the core function that replaces Jimp's getBuffer(JPEG)
#[wasm_bindgen]
pub fn convert_to_jpeg(buffer: &[u8], quality: u8) -> Result<Vec<u8>, JsValue> {
    image::convert_to_jpeg(buffer, quality)
        .map_err(|e| JsValue::from_str(&e))
}

/// Convert WebP to JPEG directly (optimized path)
/// Automatically detects WebP and converts, otherwise passes through
#[wasm_bindgen]
pub fn webp_to_jpeg(buffer: &[u8], quality: u8) -> Result<Vec<u8>, JsValue> {
    image::webp_to_jpeg(buffer, quality)
        .map_err(|e| JsValue::from_str(&e))
}

/// Compress JPEG image with specified quality
/// If input is not JPEG, converts to JPEG first
#[wasm_bindgen]
pub fn compress_jpeg(buffer: &[u8], quality: u8, skip_threshold: usize) -> Result<Vec<u8>, JsValue> {
    image::compress_jpeg(buffer, quality, skip_threshold)
        .map_err(|e| JsValue::from_str(&e))
}

/// Get image dimensions without full decoding (fast)
#[wasm_bindgen]
pub fn get_dimensions(buffer: &[u8]) -> Result<JsValue, JsValue> {
    let (width, height) = image::get_dimensions(buffer)
        .map_err(|e| JsValue::from_str(&e))?;

    let obj = js_sys::Object::new();
    js_sys::Reflect::set(&obj, &"width".into(), &JsValue::from(width))?;
    js_sys::Reflect::set(&obj, &"height".into(), &JsValue::from(height))?;

    Ok(obj.into())
}

// ============================================================================
// 防审查处理 (WASM 导出)
// ============================================================================

/// 应用轻量级抗审查处理并转换为WebP格式
/// 方案A: 最小改动实现最大效率
/// - 稀疏随机噪点（仅约3%像素，±1-2亮度）
/// - 微小缩放（随机±0-1像素）
/// - 随机数字水印（低不透明度）
/// - 输出格式：统一WebP（避免QQ对JPEG的检测）
#[wasm_bindgen]
pub fn apply_anti_censorship_jpeg(
    buffer: &[u8],
    noise_intensity: f32,
) -> Result<Vec<u8>, JsValue> {
    anti_censorship::apply_anti_censorship_jpeg(buffer, noise_intensity)
        .map_err(|e| JsValue::from_str(&e))
}

// ============================================================================
// 统一处理流程 (WASM 导出)
// ============================================================================

/// Unified image processing pipeline
/// Handles: format detection -> WebP conversion -> anti-censorship -> JPEG conversion
#[wasm_bindgen]
pub fn process_image(
    buffer: &[u8],
    target_format: &str,
    quality: u8,
    apply_anti_censor: bool,
    noise_intensity: f32,
    add_border: bool,
) -> Result<Vec<u8>, JsValue> {
    image::process_image(
        buffer,
        target_format,
        quality,
        apply_anti_censor,
        noise_intensity,
        add_border,
    )
    .map_err(|e| JsValue::from_str(&e))
}

// ============================================================================
// 批处理 (WASM 导出)
// ============================================================================

/// Batch convert multiple images to JPEG
/// Returns array of results (each can be success buffer or error)
#[wasm_bindgen]
pub fn batch_convert_to_jpeg(buffers: Vec<JsValue>, quality: u8) -> Vec<JsValue> {
    batch::wasm_batch_convert_to_jpeg(buffers, quality)
}

/// Batch apply anti-censorship and convert to JPEG for multiple images
/// More efficient than processing images one by one
#[wasm_bindgen]
pub fn batch_apply_anti_censorship_jpeg(
    buffers: Vec<JsValue>,
    noise_intensity: f32,
) -> Vec<JsValue> {
    batch::wasm_batch_apply_anti_censorship_jpeg(buffers, noise_intensity)
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_detection() {
        use crate::format::detect_format;

        // JPEG magic bytes
        let jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        assert_eq!(detect_format(&jpeg), Some(image::ImageFormat::Jpeg));

        // PNG magic bytes
        let png = b"\x89PNG\r\n\x1a\n";
        assert_eq!(detect_format(png), Some(image::ImageFormat::Png));

        // Empty buffer
        let empty: &[u8] = &[];
        assert_eq!(detect_format(empty), None);
    }

    #[test]
    fn test_dimensions() {
        // Create a simple 10x10 red image
        let img = image::RgbImage::from_pixel(10, 10, image::Rgb([255, 0, 0]));
        let mut buffer = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buffer, image::ImageFormat::Png).unwrap();
        let bytes = buffer.into_inner();

        let (width, height) = image::get_dimensions(&bytes).unwrap();
        assert_eq!(width, 10);
        assert_eq!(height, 10);
    }
}
