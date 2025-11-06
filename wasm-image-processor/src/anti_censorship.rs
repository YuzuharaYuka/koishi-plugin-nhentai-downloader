// src/anti_censorship.rs
// 抗审查图片处理模块

use image::{DynamicImage, GenericImageView, ImageFormat};
use rand::Rng;
use std::io::Cursor;

/// 应用轻量级抗审查处理并转换为WebP格式
/// 方案A: 最小改动实现最大效率
/// - 稀疏随机噪点（仅约3%像素，±1-2亮度）
/// - 微小缩放（随机±0-1像素）
/// - 输出格式：统一WebP（避免QQ对JPEG的检测）
pub fn apply_anti_censorship_jpeg(
    buffer: &[u8],
    noise_intensity: f32,
    _add_border: bool,
    _quality: u8,
) -> Result<Vec<u8>, String> {
    let mut img = image::load_from_memory(buffer)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    let mut rng = rand::rng();
    let (width, height) = img.dimensions();

    // 策略1: 超轻量随机噪点（仅影响hash值，肉眼不可见）
    // 只修改约3%的像素，±1-2亮度变化
    let noise_amount = (noise_intensity.clamp(0.0, 1.0) * 2.0) as i32; // 0-2
    if noise_amount > 0 {
        let noise_ratio = 0.03;
        let total_pixels = (width * height) as f32;
        let noise_count = (total_pixels * noise_ratio) as usize;

        match &mut img {
            DynamicImage::ImageRgb8(rgb) => {
                for _ in 0..noise_count {
                    let x = rng.random_range(0..width);
                    let y = rng.random_range(0..height);
                    if let Some(pixel) = rgb.get_pixel_mut_checked(x, y) {
                        let shift = rng.random_range(-noise_amount..=noise_amount) as i8;
                        pixel[0] = pixel[0].saturating_add_signed(shift);
                        pixel[1] = pixel[1].saturating_add_signed(shift);
                        pixel[2] = pixel[2].saturating_add_signed(shift);
                    }
                }
            }
            DynamicImage::ImageRgba8(rgba) => {
                for _ in 0..noise_count {
                    let x = rng.random_range(0..width);
                    let y = rng.random_range(0..height);
                    if let Some(pixel) = rgba.get_pixel_mut_checked(x, y) {
                        let shift = rng.random_range(-noise_amount..=noise_amount) as i8;
                        pixel[0] = pixel[0].saturating_add_signed(shift);
                        pixel[1] = pixel[1].saturating_add_signed(shift);
                        pixel[2] = pixel[2].saturating_add_signed(shift);
                    }
                }
            }
            _ => {
                img = DynamicImage::ImageRgb8(img.to_rgb8());
                if let DynamicImage::ImageRgb8(rgb) = &mut img {
                    for _ in 0..noise_count {
                        let x = rng.random_range(0..width);
                        let y = rng.random_range(0..height);
                        if let Some(pixel) = rgb.get_pixel_mut_checked(x, y) {
                            let shift = rng.random_range(-noise_amount..=noise_amount) as i8;
                            pixel[0] = pixel[0].saturating_add_signed(shift);
                            pixel[1] = pixel[1].saturating_add_signed(shift);
                            pixel[2] = pixel[2].saturating_add_signed(shift);
                        }
                    }
                }
            }
        }
    }

    // 策略2: 最小缩放（±0-1像素，改变尺寸指纹）
    if rng.random_bool(0.5) {
        let direction = if rng.random_bool(0.5) { 1i32 } else { -1i32 };
        let new_width = ((width as i32) + direction).max(1) as u32;
        let new_height = ((height as i32) + direction).max(1) as u32;

        if new_width != width || new_height != height {
            img = img.resize_exact(new_width, new_height, image::imageops::FilterType::Triangle);
        }
    }

    // 策略3: 统一编码为WebP格式（避免QQ对JPEG的检测）
    // WebP压缩更高效且更不容易被风控
    let mut output = Cursor::new(Vec::new());
    img.write_to(&mut output, ImageFormat::WebP)
        .map_err(|e| format!("Failed to encode WebP: {}", e))?;

    Ok(output.into_inner())
}
