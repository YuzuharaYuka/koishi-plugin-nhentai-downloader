// src/image.rs
// 图片转换、压缩和处理模块

use image::{GenericImageView, ImageFormat};
use std::io::Cursor;

use crate::format::detect_format;

/// Calculate optimal JPEG quality based on image dimensions
///
/// Strategy:
/// - Large images (>4MP): reduce quality by 10% for better compression
/// - Small images (<0.5MP): increase quality by 5% for better visual quality
/// - Medium images: use specified quality
fn calculate_optimal_quality(width: u32, height: u32, base_quality: u8) -> u8 {
    let pixels = width * height;
    let megapixels = pixels as f64 / 1_000_000.0;

    let adjusted = if megapixels > 4.0 {
        // Large image: reduce quality
        base_quality.saturating_sub(10)
    } else if megapixels < 0.5 {
        // Small image: increase quality
        base_quality.saturating_add(5).min(100)
    } else {
        base_quality
    };

    adjusted.clamp(1, 100)
}

/// Convert any image format to JPEG with specified quality
/// This is the core function that replaces Jimp's getBuffer(JPEG)
pub fn convert_to_jpeg(buffer: &[u8], quality: u8) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(buffer)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    let (width, height) = img.dimensions();
    let optimal_quality = calculate_optimal_quality(width, height, quality);

    let mut output = Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, optimal_quality);

    encoder
        .encode_image(&img)
        .map_err(|e| format!("Failed to encode JPEG: {}", e))?;

    Ok(output.into_inner())
}

/// Convert WebP to JPEG directly (optimized path)
/// Automatically detects WebP and converts, otherwise passes through
pub fn webp_to_jpeg(buffer: &[u8], quality: u8) -> Result<Vec<u8>, String> {
    let format = detect_format(buffer);

    if format != Some(ImageFormat::WebP) {
        // Not WebP, convert normally
        return convert_to_jpeg(buffer, quality);
    }

    // WebP detected, decode and convert
    let img = image::load_from_memory_with_format(buffer, ImageFormat::WebP)
        .map_err(|e| format!("Failed to decode WebP: {}", e))?;

    let (width, height) = img.dimensions();
    let optimal_quality = calculate_optimal_quality(width, height, quality);

    let mut output = Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, optimal_quality);

    encoder
        .encode_image(&img)
        .map_err(|e| format!("Failed to encode JPEG: {}", e))?;

    Ok(output.into_inner())
}

/// Compress JPEG image with specified quality
/// If input is not JPEG, converts to JPEG first
pub fn compress_jpeg(buffer: &[u8], quality: u8, skip_threshold: usize) -> Result<Vec<u8>, String> {
    // Skip compression if below threshold
    if skip_threshold > 0 && buffer.len() < skip_threshold {
        return Ok(buffer.to_vec());
    }

    convert_to_jpeg(buffer, quality)
}

/// Unified image processing pipeline
/// Handles: format detection -> WebP conversion -> anti-censorship -> JPEG conversion
pub fn process_image(
    buffer: &[u8],
    target_format: &str,
    quality: u8,
    apply_anti_censor: bool,
    noise_intensity: f32,
    _add_border: bool,
) -> Result<Vec<u8>, String> {
    let format = detect_format(buffer);

    // WebP special handling
    if format == Some(ImageFormat::WebP) {
        let jpeg = webp_to_jpeg(buffer, quality)?;

        if apply_anti_censor {
            return crate::anti_censorship::apply_anti_censorship_jpeg(
                &jpeg,
                noise_intensity,
            );
        }

        return Ok(jpeg);
    }

    // Anti-censorship processing (统一输出WebP格式)
    if apply_anti_censor {
        return crate::anti_censorship::apply_anti_censorship_jpeg(
            buffer,
            noise_intensity,
        );
    }

    // Standard conversion
    match target_format {
        "jpeg" | "jpg" => convert_to_jpeg(buffer, quality),
        "png" => {
            let img = image::load_from_memory(buffer)
                .map_err(|e| format!("Failed to decode image: {}", e))?;

            let mut output = Cursor::new(Vec::new());
            img.write_to(&mut output, ImageFormat::Png)
                .map_err(|e| format!("Failed to encode PNG: {}", e))?;

            Ok(output.into_inner())
        }
        _ => Err(format!("Unsupported target format: {}", target_format)),
    }
}

/// Get image dimensions without full decoding (fast)
pub fn get_dimensions(buffer: &[u8]) -> Result<(u32, u32), String> {
    let img = image::load_from_memory(buffer)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    Ok(img.dimensions())
}
