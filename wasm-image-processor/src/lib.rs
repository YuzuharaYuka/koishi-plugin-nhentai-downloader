// src/lib.rs - 主入口模块，重导出所有公共 API

use wasm_bindgen::prelude::*;

mod format;
mod image;
mod anti_censorship;
mod batch;

// 将 Rust 错误转换为 JS 错误
fn map_error_to_jsvalue(err: String) -> JsValue {
    JsValue::from_str(&err)
}

// 创建维度对象 { width, height }
fn create_dimensions_object(width: u32, height: u32) -> Result<JsValue, JsValue> {
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(&obj, &"width".into(), &JsValue::from(width))?;
    js_sys::Reflect::set(&obj, &"height".into(), &JsValue::from(height))?;
    Ok(obj.into())
}

// WASM 初始化：配置调试钩子
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

// 图片转换与处理 (WASM 导出)
/// 将任意图片格式转换为 JPEG（指定质量）。
#[wasm_bindgen]
pub fn convert_to_jpeg(buffer: &[u8], quality: u8) -> Result<Vec<u8>, JsValue> {
    image::convert_to_jpeg(buffer, quality)
        .map_err(map_error_to_jsvalue)
}

/// WebP 转 JPEG（优化路径）。自动检测 WebP 并转换，否则通过标准路径处理
#[wasm_bindgen]
pub fn webp_to_jpeg(buffer: &[u8], quality: u8) -> Result<Vec<u8>, JsValue> {
    image::webp_to_jpeg(buffer, quality)
        .map_err(map_error_to_jsvalue)
}

/// 压缩 JPEG 图片（指定质量）。若输入非 JPEG，先转换为 JPEG；若小于阈值则跳过压缩
#[wasm_bindgen]
pub fn compress_jpeg(buffer: &[u8], quality: u8, skip_threshold: usize) -> Result<Vec<u8>, JsValue> {
    image::compress_jpeg(buffer, quality, skip_threshold)
        .map_err(map_error_to_jsvalue)
}

/// 获取图片尺寸（无需完整解码，速度快）
#[wasm_bindgen]
pub fn get_dimensions(buffer: &[u8]) -> Result<JsValue, JsValue> {
    let (width, height) = image::get_dimensions(buffer)
        .map_err(map_error_to_jsvalue)?;

    create_dimensions_object(width, height)
}

// 防审查处理 (WASM 导出)
/// 应用轻量级抗审查处理并转换为WebP格式。
#[wasm_bindgen]
pub fn apply_anti_censorship_jpeg(
    buffer: &[u8],
    noise_intensity: f32,
) -> Result<Vec<u8>, JsValue> {
    anti_censorship::apply_anti_censorship_jpeg(buffer, noise_intensity)
        .map_err(map_error_to_jsvalue)
}

// 统一处理流程 (WASM 导出)
/// 统一图片处理管道：格式检测 -> WebP 转换 -> 抗审查处理 -> JPEG/PNG 转换
#[wasm_bindgen]
pub fn process_image(
    buffer: &[u8],
    target_format: &str,
    quality: u8,
    apply_anti_censor: bool,
    noise_intensity: f32,
    add_border: bool,
) -> Result<Vec<u8>, JsValue> {
    let _ = add_border; // 参数保留用于向后兼容
    image::process_image(
        buffer,
        target_format,
        quality,
        apply_anti_censor,
        noise_intensity,
    )
    .map_err(map_error_to_jsvalue)
}

// 批处理 (WASM 导出)
/// 批量将多张图片转换为 JPEG。返回结果数组（每项可为成功缓冲或错误字符串）
#[wasm_bindgen]
pub fn batch_convert_to_jpeg(buffers: Vec<JsValue>, quality: u8) -> Vec<JsValue> {
    batch::wasm_batch_convert_to_jpeg(buffers, quality)
}

/// 批量应用抗审查处理和 JPEG 转换。比逐个处理更高效
#[wasm_bindgen]
pub fn batch_apply_anti_censorship_jpeg(
    buffers: Vec<JsValue>,
    noise_intensity: f32,
) -> Vec<JsValue> {
    batch::wasm_batch_apply_anti_censorship_jpeg(buffers, noise_intensity)
}

// 测试
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_detection() {
        use crate::format::detect_format;

        let jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]; // JPEG 魔数
        assert_eq!(detect_format(&jpeg), Some(image::ImageFormat::Jpeg));

        let png = b"\x89PNG\r\n\x1a\n"; // PNG 魔数
        assert_eq!(detect_format(png), Some(image::ImageFormat::Png));

        let empty: &[u8] = &[]; // 空缓冲
        assert_eq!(detect_format(empty), None);
    }

    #[test]
    fn test_dimensions() {
        // 创建 10x10 红色图片
        let img = image::RgbImage::from_pixel(10, 10, image::Rgb([255, 0, 0]));
        let mut buffer = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buffer, image::ImageFormat::Png).unwrap();
        let bytes = buffer.into_inner();

        let (width, height) = image::get_dimensions(&bytes).unwrap();
        assert_eq!(width, 10);
        assert_eq!(height, 10);
    }
}
