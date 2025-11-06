// src/anti_censorship.rs
// 抗审查图片处理模块

use image::{DynamicImage, GenericImageView, ImageFormat, Rgba, RgbaImage};
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
    // 策略3: 添加轻量水印（随机单个数字，低不透明度）以模拟 sharp SVG 水印的效果
    // 我们使用内置小型位图数字字体（5x7）以避免外部字体依赖，然后进行 alpha 混合。
    // 计算水印参数
    let mut rng = rand::rng();
    let watermark_digit = (rng.random_range(0..10) as u8) % 10; // 0-9
    let (width, height) = img.dimensions();
    let font_size = std::cmp::max(8u32, width / 150); // 与 JS 版本相似
    let margin = (font_size / 2) as i32;
    let opacity = 0.15f32;

    // 随机角落位置：0 TL, 1 TR, 2 BR, 3 BL
    let position = if rng.random_bool(0.5) { rng.random_range(0..4) } else { rng.random_range(0..4) };

    // 将 DynamicImage 转为 RGBA 图以便像素混合
    let mut rgba: RgbaImage = img.to_rgba8();

    // 内置 5x7 位图数字字形（0-9），1 表示像素点
    const DIGITS: [[u8; 35]; 10] = [
        // 0
        [0,1,1,1,0,
         1,0,0,0,1,
         1,0,0,1,1,
         1,0,1,0,1,
         1,1,0,0,1,
         1,0,0,0,1,
         0,1,1,1,0],
        // 1
        [0,0,1,0,0,
         0,1,1,0,0,
         1,0,1,0,0,
         0,0,1,0,0,
         0,0,1,0,0,
         0,0,1,0,0,
         1,1,1,1,1],
        // 2
        [0,1,1,1,0,
         1,0,0,0,1,
         0,0,0,0,1,
         0,0,0,1,0,
         0,0,1,0,0,
         0,1,0,0,0,
         1,1,1,1,1],
        // 3
        [0,1,1,1,0,
         1,0,0,0,1,
         0,0,0,0,1,
         0,0,1,1,0,
         0,0,0,0,1,
         1,0,0,0,1,
         0,1,1,1,0],
        // 4
        [0,0,0,1,0,
         0,0,1,1,0,
         0,1,0,1,0,
         1,0,0,1,0,
         1,1,1,1,1,
         0,0,0,1,0,
         0,0,0,1,0],
        // 5
        [1,1,1,1,1,
         1,0,0,0,0,
         1,1,1,1,0,
         0,0,0,0,1,
         0,0,0,0,1,
         1,0,0,0,1,
         0,1,1,1,0],
        // 6
        [0,1,1,1,0,
         1,0,0,0,1,
         1,0,0,0,0,
         1,1,1,1,0,
         1,0,0,0,1,
         1,0,0,0,1,
         0,1,1,1,0],
        // 7
        [1,1,1,1,1,
         0,0,0,0,1,
         0,0,0,1,0,
         0,0,1,0,0,
         0,1,0,0,0,
         0,1,0,0,0,
         0,1,0,0,0],
        // 8
        [0,1,1,1,0,
         1,0,0,0,1,
         1,0,0,0,1,
         0,1,1,1,0,
         1,0,0,0,1,
         1,0,0,0,1,
         0,1,1,1,0],
        // 9
        [0,1,1,1,0,
         1,0,0,0,1,
         1,0,0,0,1,
         0,1,1,1,1,
         0,0,0,0,1,
         1,0,0,0,1,
         0,1,1,1,0],
    ];

    // 将位图字体绘制到 rgba 图像并混合
    fn draw_digit(rgba: &mut RgbaImage, digit: u8, start_x: i32, start_y: i32, scale: u32, color: Rgba<u8>, alpha: f32) {
        let idx = (digit.min(9)) as usize;
        let glyph = DIGITS[idx];
        let glyph_w = 5i32;
        let glyph_h = 7i32;
        let w = rgba.width() as i32;
        let h = rgba.height() as i32;
        for gy in 0..glyph_h {
            for gx in 0..glyph_w {
                let pixel_on = glyph[(gy * glyph_w + gx) as usize] != 0;
                if !pixel_on { continue; }
                // scale and plot
                for sy in 0..(scale as i32) {
                    for sx in 0..(scale as i32) {
                        let x = start_x + gx * (scale as i32) + sx;
                        let y = start_y + gy * (scale as i32) + sy;
                        if x < 0 || y < 0 || x >= w || y >= h { continue; }
                        let px = rgba.get_pixel_mut(x as u32, y as u32);
                        // alpha blend: out = src*(1-a) + fg*a
                        let a = alpha;
                        for c in 0..3 {
                            let src_v = px[c] as f32 / 255.0;
                            let fg_v = color[c] as f32 / 255.0;
                            let out_v = (src_v * (1.0 - a) + fg_v * a).clamp(0.0, 1.0);
                            px[c] = (out_v * 255.0 + 0.5) as u8;
                        }
                        // keep original alpha
                    }
                }
            }
        }
    }

    // 计算水印位置
    let scaled = font_size.max(8);
    // 文字宽度 = 5 * scale, 高度 = 7 * scale
    let text_w = (5u32 * scaled) as i32;
    let text_h = (7u32 * scaled) as i32;
    let (x, y) = match position {
        0 => (margin, margin),                               // TL
        1 => ((width as i32) - margin - text_w, margin),     // TR
        2 => ((width as i32) - margin - text_w, (height as i32) - margin - text_h), // BR
        _ => (margin, (height as i32) - margin - text_h),   // BL
    };

    // 黑色半透明水印
    let fg = Rgba([0u8, 0u8, 0u8, 255u8]);
    draw_digit(&mut rgba, watermark_digit, x, y, scaled, fg, opacity);

    // 编码为 WebP 输出
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(rgba).write_to(&mut output, ImageFormat::WebP)
        .map_err(|e| format!("Failed to encode WebP: {}", e))?;
    Ok(output.into_inner())
}
