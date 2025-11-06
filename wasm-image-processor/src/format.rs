// src/format.rs
// 图片格式检测模块

use image::ImageFormat;

/// Detect image format from buffer
///
/// Supports: WebP, PNG, JPEG, GIF, BMP, AVIF
pub fn detect_format(buffer: &[u8]) -> Option<ImageFormat> {
    if buffer.len() < 12 {
        return None;
    }

    // WebP: RIFF....WEBP
    if &buffer[0..4] == b"RIFF" && buffer.len() > 12 && &buffer[8..12] == b"WEBP" {
        return Some(ImageFormat::WebP);
    }

    // PNG: 89 50 4E 47
    if buffer.len() >= 8 && &buffer[0..8] == b"\x89PNG\r\n\x1a\n" {
        return Some(ImageFormat::Png);
    }

    // JPEG: FF D8 FF
    if buffer.len() >= 3 && buffer[0] == 0xFF && buffer[1] == 0xD8 && buffer[2] == 0xFF {
        return Some(ImageFormat::Jpeg);
    }

    // GIF: GIF87a or GIF89a
    if buffer.len() >= 6 && (&buffer[0..3] == b"GIF") {
        return Some(ImageFormat::Gif);
    }

    // BMP: BM
    if buffer.len() >= 2 && &buffer[0..2] == b"BM" {
        return Some(ImageFormat::Bmp);
    }

    // AVIF: ftyp...avif
    if buffer.len() >= 12 {
        if &buffer[4..8] == b"ftyp" {
            // Check for AVIF brands
            if buffer.len() >= 16 {
                let brand = &buffer[8..12];
                if brand == b"avif" || brand == b"avis" {
                    return Some(ImageFormat::Avif);
                }
            }
        }
    }

    None
}

/// Get file extension for image format
#[allow(dead_code)]
pub fn get_extension(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpg",
        ImageFormat::Gif => "gif",
        ImageFormat::WebP => "webp",
        ImageFormat::Bmp => "bmp",
        ImageFormat::Avif => "avif",
        _ => "bin",
    }
}
