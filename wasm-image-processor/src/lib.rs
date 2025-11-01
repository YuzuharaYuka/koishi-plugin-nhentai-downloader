use image::{DynamicImage, GenericImageView, ImageFormat, Rgba, RgbaImage};
use rand::Rng;
use std::io::Cursor;
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

#[cfg(feature = "console_error_panic_hook")]
pub use console_error_panic_hook::set_once as set_panic_hook;

/// Initialize the WASM module
#[wasm_bindgen(start)]
pub fn init() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// Detect image format from buffer
fn detect_format(buffer: &[u8]) -> Option<ImageFormat> {
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

    None
}

/// Convert any image format to JPEG with specified quality
/// This is the core function that replaces Jimp's getBuffer(JPEG)
#[wasm_bindgen]
pub fn convert_to_jpeg(buffer: &[u8], quality: u8) -> Result<Vec<u8>, JsValue> {
    // Load image from buffer (auto-detect format)
    let img = image::load_from_memory(buffer)
        .map_err(|e| JsValue::from_str(&format!("Failed to load image: {}", e)))?;

    // Convert to RGB8 (JPEG doesn't support alpha channel)
    let rgb_img = img.to_rgb8();

    // Encode to JPEG with specified quality
    let mut output = Vec::new();
    let mut cursor = Cursor::new(&mut output);

    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
    rgb_img
        .write_with_encoder(encoder)
        .map_err(|e| JsValue::from_str(&format!("Failed to encode JPEG: {}", e)))?;

    Ok(output)
}

/// Convert WebP to JPEG directly (optimized path)
/// Automatically detects WebP and converts, otherwise passes through
#[wasm_bindgen]
pub fn webp_to_jpeg(buffer: &[u8], quality: u8) -> Result<Vec<u8>, JsValue> {
    let format = detect_format(buffer);

    match format {
        Some(ImageFormat::WebP) => {
            // Decode WebP
            let img = image::load_from_memory_with_format(buffer, ImageFormat::WebP)
                .map_err(|e| JsValue::from_str(&format!("Failed to decode WebP: {}", e)))?;

            // Convert to JPEG
            let rgb_img = img.to_rgb8();
            let mut output = Vec::new();
            let mut cursor = Cursor::new(&mut output);

            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
            rgb_img
                .write_with_encoder(encoder)
                .map_err(|e| JsValue::from_str(&format!("Failed to encode JPEG: {}", e)))?;

            Ok(output)
        }
        Some(ImageFormat::Jpeg) => {
            // Already JPEG, return as-is or recompress if needed
            Ok(buffer.to_vec())
        }
        _ => {
            // Other format, convert to JPEG
            convert_to_jpeg(buffer, quality)
        }
    }
}

/// Apply anti-censorship processing with automatic format detection
/// Adds random pixel noise and optional transparent border
/// Returns PNG format (required for transparency support)
#[wasm_bindgen]
pub fn apply_anti_censorship(
    buffer: &[u8],
    noise_intensity: f32,
    add_border: bool,
) -> Result<Vec<u8>, JsValue> {
    // Load image (auto-detect format: PNG, JPEG, WebP, etc.)
    let img = image::load_from_memory(buffer)
        .map_err(|e| JsValue::from_str(&format!("Failed to load image: {}", e)))?;

    let mut rgba_img = img.to_rgba8();
    let (width, height) = rgba_img.dimensions();

    // Strategy 1: Add random pixel noise
    let noise_count = ((width * height) as f32 * noise_intensity) as usize;
    let mut rng = rand::thread_rng();

    for _ in 0..noise_count {
        let x = rng.gen_range(0..width);
        let y = rng.gen_range(0..height);

        let pixel = rgba_img.get_pixel_mut(x, y);

        // Adjust RGB values by ±1-3 (imperceptible but changes hash)
        let adjustment = rng.gen_range(1..4) * if rng.gen_bool(0.5) { 1 } else { -1 };

        pixel[0] = (pixel[0] as i32 + adjustment).clamp(0, 255) as u8;
        pixel[1] = (pixel[1] as i32 + adjustment).clamp(0, 255) as u8;
        pixel[2] = (pixel[2] as i32 + adjustment).clamp(0, 255) as u8;
    }

    // Strategy 2: Add 1-pixel transparent border if requested
    let final_img = if add_border {
        let new_width = width + 2;
        let new_height = height + 2;

        let mut bordered = RgbaImage::new(new_width, new_height);

        // Fill with transparent white
        for pixel in bordered.pixels_mut() {
            *pixel = Rgba([255, 255, 255, 0]);
        }

        // Copy original image to center
        image::imageops::replace(&mut bordered, &rgba_img, 1, 1);

        bordered
    } else {
        rgba_img
    };

    // Encode to PNG (supports transparency)
    let mut output = Vec::new();
    let mut cursor = Cursor::new(&mut output);

    DynamicImage::ImageRgba8(final_img)
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|e| JsValue::from_str(&format!("Failed to encode PNG: {}", e)))?;

    Ok(output)
}

/// Apply anti-censorship and convert to JPEG in one pass
/// Enhanced version with stronger noise and multiple encoding passes for better evasion
#[wasm_bindgen]
pub fn apply_anti_censorship_jpeg(
    buffer: &[u8],
    noise_intensity: f32,
    add_border: bool,
    quality: u8,
) -> Result<Vec<u8>, JsValue> {
    // Load image (auto-detect format: PNG, JPEG, WebP, etc.)
    let mut img = image::load_from_memory(buffer)
        .map_err(|e| JsValue::from_str(&format!("Failed to load image: {}", e)))?;

    let (mut width, mut height) = img.dimensions();
    let mut rng = rand::thread_rng();

    // Strategy 0: Apply subtle resize (0-2 pixels) to change dimensions slightly
    // This helps bypass dimension-based detection
    let resize_x = rng.gen_range(0..=2);
    let resize_y = rng.gen_range(0..=2);
    if resize_x > 0 || resize_y > 0 {
        let new_width = width + resize_x;
        let new_height = height + resize_y;
        img = img.resize_exact(new_width, new_height, image::imageops::FilterType::Triangle);
        width = new_width;
        height = new_height;
    }

    let mut rgb_img = img.to_rgb8();
    let original_width = width;
    let original_height = height;

    // Strategy 1: Enhanced random pixel noise with larger adjustment range
    // Increase noise intensity and adjustment range for better evasion
    let effective_noise_intensity = noise_intensity.max(0.0005); // At least 0.05% of pixels
    let noise_count = ((width * height) as f32 * effective_noise_intensity) as usize;

    for _ in 0..noise_count {
        let x = rng.gen_range(0..width);
        let y = rng.gen_range(0..height);

        let pixel = rgb_img.get_pixel_mut(x, y);

        // Enhanced adjustment: ±1-5 (larger range for better hash change)
        // More aggressive adjustment in edge areas where it's less noticeable
        let is_edge = x < 2 || x >= width - 2 || y < 2 || y >= height - 2;
        let max_adjust = if is_edge { 8 } else { 5 };
        let adjustment = rng.gen_range(1..=max_adjust) * if rng.gen_bool(0.5) { 1 } else { -1 };

        // Apply adjustment to all RGB channels with slight variation
        let r_adj = adjustment;
        let g_adj = adjustment + if rng.gen_bool(0.3) { if rng.gen_bool(0.5) { 1 } else { -1 } } else { 0 };
        let b_adj = adjustment + if rng.gen_bool(0.3) { if rng.gen_bool(0.5) { 1 } else { -1 } } else { 0 };

        pixel[0] = (pixel[0] as i32 + r_adj).clamp(0, 255) as u8;
        pixel[1] = (pixel[1] as i32 + g_adj).clamp(0, 255) as u8;
        pixel[2] = (pixel[2] as i32 + b_adj).clamp(0, 255) as u8;
    }

    // Strategy 2: Add random subtle noise to edge pixels (more effective for detection bypass)
    let edge_noise_count = ((width * 2 + height * 2) as f32 * 0.1) as usize;
    for _ in 0..edge_noise_count {
        let edge_choice = rng.gen_range(0..4);
        let (x, y) = match edge_choice {
            0 => (rng.gen_range(0..width), 0), // Top edge
            1 => (rng.gen_range(0..width), height - 1), // Bottom edge
            2 => (0, rng.gen_range(0..height)), // Left edge
            _ => (width - 1, rng.gen_range(0..height)), // Right edge
        };
        let pixel = rgb_img.get_pixel_mut(x, y);
        let adjustment = rng.gen_range(1..=6) * if rng.gen_bool(0.5) { 1 } else { -1 };
        pixel[0] = (pixel[0] as i32 + adjustment).clamp(0, 255) as u8;
        pixel[1] = (pixel[1] as i32 + adjustment).clamp(0, 255) as u8;
        pixel[2] = (pixel[2] as i32 + adjustment).clamp(0, 255) as u8;
    }

    // Strategy 3: Add border if requested
    let final_img = if add_border {
        let new_width = original_width + 2;
        let new_height = original_height + 2;

        let mut bordered = image::RgbImage::new(new_width, new_height);

        // Fill border with slightly randomized white (not pure white for better evasion)
        let border_r = rng.gen_range(252..=255);
        let border_g = rng.gen_range(252..=255);
        let border_b = rng.gen_range(252..=255);
        for pixel in bordered.pixels_mut() {
            *pixel = image::Rgb([border_r, border_g, border_b]);
        }

        // Copy original image to center
        image::imageops::replace(&mut bordered, &rgb_img, 1, 1);

        bordered
    } else {
        rgb_img
    };

    // Strategy 4: Multiple encode/decode passes to accumulate JPEG artifacts variation
    // This mimics sharp's behavior of accumulating encoding artifacts
    let mut intermediate = Vec::new();
    let mut cursor = Cursor::new(&mut intermediate);

    // First pass: encode with slightly different quality to introduce variation
    let first_quality = (quality as i32 + rng.gen_range(-2..=2)).clamp(75, 95) as u8;
    let encoder1 = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, first_quality);
    final_img
        .write_with_encoder(encoder1)
        .map_err(|e| JsValue::from_str(&format!("Failed to encode JPEG (first pass): {}", e)))?;

    // Second pass: decode and re-encode with target quality (adds more variation)
    let decoded = image::load_from_memory(&intermediate)
        .map_err(|e| JsValue::from_str(&format!("Failed to decode intermediate JPEG: {}", e)))?;
    let decoded_rgb = decoded.to_rgb8();

    // Final encode with target quality
    let mut output = Vec::new();
    let mut cursor = Cursor::new(&mut output);
    let encoder2 = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
    decoded_rgb
        .write_with_encoder(encoder2)
        .map_err(|e| JsValue::from_str(&format!("Failed to encode JPEG (final pass): {}", e)))?;

    Ok(output)
}

/// Get image dimensions without full decoding (fast)
#[wasm_bindgen]
pub fn get_dimensions(buffer: &[u8]) -> Result<JsValue, JsValue> {
    let reader = image::ImageReader::new(Cursor::new(buffer))
        .with_guessed_format()
        .map_err(|e| JsValue::from_str(&format!("Failed to read image: {}", e)))?;

    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| JsValue::from_str(&format!("Failed to get dimensions: {}", e)))?;

    // Create JavaScript object { width, height }
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(&obj, &"width".into(), &JsValue::from_f64(width as f64))
        .map_err(|_| JsValue::from_str("Failed to set width"))?;
    js_sys::Reflect::set(&obj, &"height".into(), &JsValue::from_f64(height as f64))
        .map_err(|_| JsValue::from_str("Failed to set height"))?;

    Ok(obj.into())
}

/// Compress JPEG image with specified quality
/// If input is not JPEG, converts to JPEG first
#[wasm_bindgen]
pub fn compress_jpeg(
    buffer: &[u8],
    quality: u8,
    skip_threshold: usize,
) -> Result<Vec<u8>, JsValue> {
    let format = detect_format(buffer);

    // If already JPEG and below threshold, return as-is
    if matches!(format, Some(ImageFormat::Jpeg)) && buffer.len() < skip_threshold {
        return Ok(buffer.to_vec());
    }

    // Otherwise, compress/convert to JPEG
    convert_to_jpeg(buffer, quality)
}

/// Process image for PDF embedding
/// Converts to JPEG, applies compression if needed
/// Returns: [buffer_bytes, width, height] as array
#[wasm_bindgen]
pub fn process_for_pdf(
    buffer: &[u8],
    enable_compression: bool,
    quality: u8,
    skip_threshold: usize,
) -> Result<Vec<u8>, JsValue> {
    let format = detect_format(buffer);

    // Get dimensions first
    let img = image::load_from_memory(buffer)
        .map_err(|e| JsValue::from_str(&format!("Failed to load image: {}", e)))?;
    let (width, height) = (img.width(), img.height());

    let processed_buffer = if enable_compression {
        // Apply compression
        if matches!(format, Some(ImageFormat::Jpeg)) && buffer.len() < skip_threshold {
            // Small JPEG, skip recompression
            buffer.to_vec()
        } else {
            // Compress to JPEG
            convert_to_jpeg(buffer, quality)?
        }
    } else {
        // No compression, just ensure it's JPEG
        if matches!(format, Some(ImageFormat::Jpeg)) {
            buffer.to_vec()
        } else {
            convert_to_jpeg(buffer, 100)?
        }
    };

    // Pack result: [width (4 bytes), height (4 bytes), ...buffer]
    let mut result = Vec::with_capacity(8 + processed_buffer.len());
    result.extend_from_slice(&(width as u32).to_le_bytes());
    result.extend_from_slice(&(height as u32).to_le_bytes());
    result.extend_from_slice(&processed_buffer);

    Ok(result)
}

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
    // Load image (auto-detect source format)
    let mut img = image::load_from_memory(buffer)
        .map_err(|e| JsValue::from_str(&format!("Failed to load image: {}", e)))?;

    // Apply anti-censorship if requested
    if apply_anti_censor {
        let mut rgba_img = img.to_rgba8();
        let (width, height) = rgba_img.dimensions();

        // Add noise
        let noise_count = ((width * height) as f32 * noise_intensity) as usize;
        let mut rng = rand::thread_rng();

        for _ in 0..noise_count {
            let x = rng.gen_range(0..width);
            let y = rng.gen_range(0..height);
            let pixel = rgba_img.get_pixel_mut(x, y);

            let adjustment = rng.gen_range(1..4) * if rng.gen_bool(0.5) { 1 } else { -1 };
            pixel[0] = (pixel[0] as i32 + adjustment).clamp(0, 255) as u8;
            pixel[1] = (pixel[1] as i32 + adjustment).clamp(0, 255) as u8;
            pixel[2] = (pixel[2] as i32 + adjustment).clamp(0, 255) as u8;
        }

        // Add border
        if add_border {
            let new_width = width + 2;
            let new_height = height + 2;
            let mut bordered = RgbaImage::new(new_width, new_height);

            for pixel in bordered.pixels_mut() {
                *pixel = Rgba([255, 255, 255, 0]);
            }

            image::imageops::replace(&mut bordered, &rgba_img, 1, 1);
            img = DynamicImage::ImageRgba8(bordered);
        } else {
            img = DynamicImage::ImageRgba8(rgba_img);
        }
    }

    // Convert to target format
    let mut output = Vec::new();
    let mut cursor = Cursor::new(&mut output);

    match target_format {
        "jpeg" | "jpg" => {
            let rgb_img = img.to_rgb8();
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, quality);
            rgb_img
                .write_with_encoder(encoder)
                .map_err(|e| JsValue::from_str(&format!("Failed to encode JPEG: {}", e)))?;
        }
        "png" => {
            img.write_to(&mut cursor, ImageFormat::Png)
                .map_err(|e| JsValue::from_str(&format!("Failed to encode PNG: {}", e)))?;
        }
        _ => {
            return Err(JsValue::from_str(&format!(
                "Unsupported target format: {}",
                target_format
            )));
        }
    }

    Ok(output)
}

/// Batch convert multiple images to JPEG
/// Returns array of results (each can be success buffer or error)
#[wasm_bindgen]
pub fn batch_convert_to_jpeg(buffers: Vec<JsValue>, quality: u8) -> Vec<JsValue> {
    let mut results = Vec::new();

    for buffer_val in buffers {
        let uint8_array = js_sys::Uint8Array::new(&buffer_val);
        let buffer_vec = uint8_array.to_vec();

        match buffer_vec.as_slice().try_into() {
            Ok(buffer) => {
                match convert_to_jpeg(buffer, quality) {
                    Ok(result) => {
                        let result_array = js_sys::Uint8Array::from(&result[..]);
                        results.push(result_array.into());
                    }
                    Err(e) => {
                        results.push(e);
                    }
                }
            }
            Err(_) => {
                results.push(JsValue::from_str("Invalid buffer"));
            }
        }
    }

    results
}

/// Batch apply anti-censorship and convert to JPEG for multiple images
/// More efficient than processing images one by one
#[wasm_bindgen]
pub fn batch_apply_anti_censorship_jpeg(
    buffers: Vec<JsValue>,
    noise_intensity: f32,
    add_border: bool,
    quality: u8,
) -> Vec<JsValue> {
    let mut results = Vec::new();

    for buffer_val in buffers {
        // Clone the value before attempting conversion since dyn_into takes ownership
        let buffer_val_clone = buffer_val.clone();
        if let Ok(buffer_array) = buffer_val_clone.dyn_into::<js_sys::Uint8Array>() {
            let buffer: Vec<u8> = buffer_array.to_vec();
            // Use enhanced noise intensity for batch processing
            let enhanced_noise = noise_intensity.max(0.0005);
            match apply_anti_censorship_jpeg(&buffer, enhanced_noise, add_border, quality) {
                Ok(result) => {
                    let uint8_array = js_sys::Uint8Array::from(&result[..]);
                    results.push(uint8_array.into());
                }
                Err(_) => {
                    // On error, return original buffer
                    results.push(buffer_array.into());
                }
            }
        } else {
            // Invalid buffer, return as-is
            results.push(buffer_val);
        }
    }

    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_detection() {
        let webp_header = b"RIFF\x00\x00\x00\x00WEBP";
        assert_eq!(detect_format(webp_header), Some(ImageFormat::WebP));

        let png_header = b"\x89PNG\r\n\x1a\n";
        assert_eq!(detect_format(png_header), Some(ImageFormat::Png));

        let jpeg_header = b"\xFF\xD8\xFF";
        assert_eq!(detect_format(jpeg_header), Some(ImageFormat::Jpeg));
    }

    #[test]
    fn test_empty_buffer() {
        let empty: &[u8] = &[];
        assert_eq!(detect_format(empty), None);
    }
}
