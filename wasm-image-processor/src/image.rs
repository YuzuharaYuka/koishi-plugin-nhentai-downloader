// src/image.rs - 图片转换、压缩和处理模块

use image::{DynamicImage, GenericImageView, ImageFormat};
use std::io::Cursor;

use crate::format::detect_format;

// 图片优化阈值常量
const LARGE_IMAGE_MP: f64 = 4.0; // 大图定义：> 4MP
const SMALL_IMAGE_MP: f64 = 0.5; // 小图定义：< 0.5MP
const LARGE_IMAGE_QUALITY_DELTA: u8 = 10; // 大图质量降低幅度
const SMALL_IMAGE_QUALITY_DELTA: u8 = 5; // 小图质量提升幅度

/// 根据图片尺寸计算最优 JPEG 质量。策略: 大图(>4MP)降低10%质量以提升压缩率；小图(<0.5MP)提升5%质量以增强视觉效果；中等图片使用指定质量
fn calculate_optimal_quality(width: u32, height: u32, base_quality: u8) -> u8 {
    let pixels = width * height;
    let megapixels = pixels as f64 / 1_000_000.0;

    let adjusted = if megapixels > LARGE_IMAGE_MP {
        base_quality.saturating_sub(LARGE_IMAGE_QUALITY_DELTA) // 大图：降低质量以提升压缩率
    } else if megapixels < SMALL_IMAGE_MP {
        base_quality.saturating_add(SMALL_IMAGE_QUALITY_DELTA).min(100) // 小图：提升质量以增强视觉效果
    } else {
        base_quality
    };

    adjusted.clamp(1, 100)
}

// 通用 JPEG 编码辅助：将 DynamicImage 编码为 JPEG 字节流
fn encode_to_jpeg_bytes(img: &DynamicImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut output = Cursor::new(Vec::new());
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality);
    encoder.encode_image(img).map_err(|e| format!("Failed to encode JPEG: {}", e))?;
    Ok(output.into_inner())
}

/// 将任意图片格式转换为 JPEG（指定质量）。这是替代 Jimp 的 getBuffer(JPEG) 的核心函数
pub fn convert_to_jpeg(buffer: &[u8], quality: u8) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(buffer)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    let (width, height) = img.dimensions();
    let optimal_quality = calculate_optimal_quality(width, height, quality);

    encode_to_jpeg_bytes(&img, optimal_quality)
}

/// WebP 转 JPEG（优化路径）。自动检测 WebP 并转换，否则通过标准路径处理
pub fn webp_to_jpeg(buffer: &[u8], quality: u8) -> Result<Vec<u8>, String> {
    let format = detect_format(buffer);

    let img = if format == Some(ImageFormat::WebP) {
        // WebP 检测成功，用指定格式解码
        image::load_from_memory_with_format(buffer, ImageFormat::WebP)
            .map_err(|e| format!("Failed to decode WebP: {}", e))?
    } else {
        // 非 WebP，使用通用解码
        image::load_from_memory(buffer)
            .map_err(|e| format!("Failed to decode image: {}", e))?
    };

    let (width, height) = img.dimensions();
    let optimal_quality = calculate_optimal_quality(width, height, quality);

    encode_to_jpeg_bytes(&img, optimal_quality)
}

/// 压缩 JPEG 图片（指定质量）。若输入非 JPEG，先转换为 JPEG；若小于阈值则跳过压缩
pub fn compress_jpeg(buffer: &[u8], quality: u8, skip_threshold: usize) -> Result<Vec<u8>, String> {
    if skip_threshold > 0 && buffer.len() < skip_threshold {
        return Ok(buffer.to_vec()); // 阈值检查：低于阈值则跳过压缩
    }

    convert_to_jpeg(buffer, quality)
}

/// 统一图片处理管道：格式检测 -> WebP 转换 -> 抗审查处理 -> JPEG/PNG 转换
pub fn process_image(
    buffer: &[u8],
    target_format: &str,
    quality: u8,
    apply_anti_censor: bool,
    noise_intensity: f32,
) -> Result<Vec<u8>, String> {
    let format = detect_format(buffer);

    // WebP 特殊处理
    if format == Some(ImageFormat::WebP) {
        let jpeg = webp_to_jpeg(buffer, quality)?;
        if apply_anti_censor {
            return crate::anti_censorship::apply_anti_censorship_jpeg(&jpeg, noise_intensity);
        }
        return Ok(jpeg);
    }

    // 抗审查处理（统一输出 WebP 格式）
    if apply_anti_censor {
        return crate::anti_censorship::apply_anti_censorship_jpeg(buffer, noise_intensity);
    }

    // 标准格式转换
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

/// 获取图片尺寸（无需完整解码，速度快）
pub fn get_dimensions(buffer: &[u8]) -> Result<(u32, u32), String> {
    let img = image::load_from_memory(buffer)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    Ok(img.dimensions())
}
