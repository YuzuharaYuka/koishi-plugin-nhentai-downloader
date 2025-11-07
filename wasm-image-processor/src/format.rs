// src/format.rs - 图片格式检测模块

use image::ImageFormat;

// 格式检测常量
const MIN_BUFFER_LEN: usize = 12;
const AVIF_MIN_LEN: usize = 16;
const WEBP_OFFSET: usize = 8;
const JPEG_MIN_LEN: usize = 3;
const GIF_MIN_LEN: usize = 6;
const BMP_MIN_LEN: usize = 2;

/// 从缓冲区检测图片格式。支持: WebP、PNG、JPEG、GIF、BMP、AVIF
pub fn detect_format(buffer: &[u8]) -> Option<ImageFormat> {
    if buffer.len() < MIN_BUFFER_LEN {
        return None;
    }

    if &buffer[0..4] == b"RIFF" && buffer.len() > MIN_BUFFER_LEN && &buffer[WEBP_OFFSET..12] == b"WEBP" {
        return Some(ImageFormat::WebP); // WebP: RIFF....WEBP
    }

    if buffer.len() >= 8 && &buffer[0..8] == b"\x89PNG\r\n\x1a\n" {
        return Some(ImageFormat::Png); // PNG: 89 50 4E 47
    }

    if buffer.len() >= JPEG_MIN_LEN && buffer[0] == 0xFF && buffer[1] == 0xD8 && buffer[2] == 0xFF {
        return Some(ImageFormat::Jpeg); // JPEG: FF D8 FF
    }

    if buffer.len() >= GIF_MIN_LEN && &buffer[0..3] == b"GIF" {
        return Some(ImageFormat::Gif); // GIF: GIF87a or GIF89a
    }

    if buffer.len() >= BMP_MIN_LEN && &buffer[0..2] == b"BM" {
        return Some(ImageFormat::Bmp); // BMP: BM
    }

    if buffer.len() >= AVIF_MIN_LEN && &buffer[4..8] == b"ftyp" {
        let brand = &buffer[WEBP_OFFSET..12];
        // AVIF: ftyp...avif 或 ftyp...avis
        if brand == b"avif" || brand == b"avis" {
            return Some(ImageFormat::Avif);
        }
    }

    None
}
