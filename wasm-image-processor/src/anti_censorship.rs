// src/anti_censorship.rs
// 抗审查图片处理模块

use image::{DynamicImage, GenericImageView, ImageFormat, Rgba, RgbaImage};
use rand::Rng;
use std::io::Cursor;

/// 应用轻量级抗审查处理并转换为WebP格式
/// 策略: 添加随机单个数字水印（低不透明度）
/// - 使用内置 5x7 位图数字字体（0-9）
/// - 随机选择数字和角落位置
/// - 低不透明度（15%）黑色半透明水印
/// - 输出格式：统一 WebP（避免平台对 JPEG 的检测）
///
/// 参数 `_noise_intensity` 保留用于向后兼容，但当前未使用
pub fn apply_anti_censorship_jpeg(
    buffer: &[u8],
    _noise_intensity: f32,
) -> Result<Vec<u8>, String> {
    let img = image::load_from_memory(buffer)
        .map_err(|e| format!("Failed to decode image: {}", e))?;

    let mut rng = rand::rng();
    let (width, height) = img.dimensions();

    // 计算水印参数
    let watermark_digit = rng.random_range(0..10) as u8; // 0-9
    let font_size = std::cmp::max(8u32, width / 150); // 与 JS 版本相似
    let margin = (font_size / 2) as i32;
    let opacity = 0.15f32;

    // 随机角落位置：0 TL, 1 TR, 2 BR, 3 BL
    let position = rng.random_range(0..4);

    // 将图像转为 RGBA 格式以便进行像素级水印混合
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
