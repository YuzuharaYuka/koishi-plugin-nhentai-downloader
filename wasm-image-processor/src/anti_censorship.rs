// src/anti_censorship.rs - 抗审查图片处理模块

use image::{DynamicImage, GenericImageView, ImageFormat, Rgba, RgbaImage};
use rand::Rng;
use std::io::Cursor;

const GLYPH_WIDTH: i32 = 5;
const GLYPH_HEIGHT: i32 = 7;
const GLYPH_SIZE: usize = 35; // GLYPH_WIDTH * GLYPH_HEIGHT
const WATERMARK_OPACITY: f32 = 0.15;

// 内置 5x7 位图数字字形（0-9），1 表示像素点
const DIGITS: [[u8; GLYPH_SIZE]; 10] = [
    [0,1,1,1,0,
     1,0,0,0,1,
     1,0,0,1,1,
     1,0,1,0,1,
     1,1,0,0,1,
     1,0,0,0,1,
     0,1,1,1,0], // 0
    [0,0,1,0,0,
     0,1,1,0,0,
     1,0,1,0,0,
     0,0,1,0,0,
     0,0,1,0,0,
     0,0,1,0,0,
     1,1,1,1,1], // 1
    [0,1,1,1,0,
     1,0,0,0,1,
     0,0,0,0,1,
     0,0,0,1,0,
     0,0,1,0,0,
     0,1,0,0,0,
     1,1,1,1,1], // 2
    [0,1,1,1,0,
     1,0,0,0,1,
     0,0,0,0,1,
     0,0,1,1,0,
     0,0,0,0,1,
     1,0,0,0,1,
     0,1,1,1,0], // 3
    [0,0,0,1,0,
     0,0,1,1,0,
     0,1,0,1,0,
     1,0,0,1,0,
     1,1,1,1,1,
     0,0,0,1,0,
     0,0,0,1,0], // 4
    [1,1,1,1,1,
     1,0,0,0,0,
     1,1,1,1,0,
     0,0,0,0,1,
     0,0,0,0,1,
     1,0,0,0,1,
     0,1,1,1,0], // 5
    [0,1,1,1,0,
     1,0,0,0,1,
     1,0,0,0,0,
     1,1,1,1,0,
     1,0,0,0,1,
     1,0,0,0,1,
     0,1,1,1,0], // 6
    [1,1,1,1,1,
     0,0,0,0,1,
     0,0,0,1,0,
     0,0,1,0,0,
     0,1,0,0,0,
     0,1,0,0,0,
     0,1,0,0,0], // 7
    [0,1,1,1,0,
     1,0,0,0,1,
     1,0,0,0,1,
     0,1,1,1,0,
     1,0,0,0,1,
     1,0,0,0,1,
     0,1,1,1,0], // 8
    [0,1,1,1,0,
     1,0,0,0,1,
     1,0,0,0,1,
     0,1,1,1,1,
     0,0,0,0,1,
     1,0,0,0,1,
     0,1,1,1,0], // 9
];

// 将位图数字绘制到 RGBA 图像并进行 alpha 混合
fn draw_digit(rgba: &mut RgbaImage, digit: u8, start_x: i32, start_y: i32, scale: u32, color: Rgba<u8>, alpha: f32) {
    let idx = (digit.min(9)) as usize;
    let glyph = DIGITS[idx];
    let w = rgba.width() as i32;
    let h = rgba.height() as i32;
    for gy in 0..GLYPH_HEIGHT {
        for gx in 0..GLYPH_WIDTH {
            let pixel_on = glyph[(gy * GLYPH_WIDTH + gx) as usize] != 0;
            if !pixel_on { continue; }
            // 按 scale 扩展每个字形像素
            for sy in 0..(scale as i32) {
                for sx in 0..(scale as i32) {
                    let x = start_x + gx * (scale as i32) + sx;
                    let y = start_y + gy * (scale as i32) + sy;
                    if x < 0 || y < 0 || x >= w || y >= h { continue; }
                    let px = rgba.get_pixel_mut(x as u32, y as u32);
                    // Alpha 混合：out = src*(1-a) + fg*a
                    for c in 0..3 {
                        let src_v = px[c] as f32 / 255.0;
                        let fg_v = color[c] as f32 / 255.0;
                        let out_v = (src_v * (1.0 - alpha) + fg_v * alpha).clamp(0.0, 1.0);
                        px[c] = (out_v * 255.0 + 0.5) as u8;
                    }
                }
            }
        }
    }
}

/// 应用轻量级抗审查处理并转换为WebP格式。策略: 添加随机单个数字水印（15% 不透明度）
/// 使用内置 5x7 位图数字字体（0-9）、随机选择数字和角落位置、输出统一 WebP 格式。
/// 参数 `_noise_intensity` 保留用于向后兼容。
pub fn apply_anti_censorship_jpeg(
    buffer: &[u8],
    _noise_intensity: f32,
) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(buffer)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    let mut rng = rand::rng();
    let (width, height) = img.dimensions();

    // 随机水印数字(0-9)、大小与边距、15% 不透明度、随机角落位置(0 TL, 1 TR, 2 BR, 3 BL)
    let watermark_digit = rng.random_range(0..10) as u8;
    let font_size = 8u32.max(width / 150);
    let margin = (font_size / 2) as i32;
    let position = rng.random_range(0..4);

    let mut rgba: RgbaImage = img.to_rgba8();

    // 计算最终的字体缩放比例和尺寸
    let scaled = font_size.max(8);
    let text_w = (GLYPH_WIDTH as u32 * scaled) as i32;
    let text_h = (GLYPH_HEIGHT as u32 * scaled) as i32;
    // 根据 position 计算水印坐标：0 TL, 1 TR, 2 BR, 3 BL
    let (x, y) = match position {
        0 => (margin, margin), // TL
        1 => ((width as i32) - margin - text_w, margin), // TR
        2 => ((width as i32) - margin - text_w, (height as i32) - margin - text_h), // BR
        _ => (margin, (height as i32) - margin - text_h), // BL
    };

    let fg = Rgba([0u8, 0u8, 0u8, 255u8]); // 黑色半透明水印
    draw_digit(&mut rgba, watermark_digit, x, y, scaled, fg, WATERMARK_OPACITY);

    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(rgba).write_to(&mut output, ImageFormat::WebP)
        .map_err(|e| format!("Failed to encode WebP: {}", e))?;
    Ok(output.into_inner())
}
