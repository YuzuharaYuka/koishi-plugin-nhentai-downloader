// src/batch.rs
// 批处理模块

use wasm_bindgen::prelude::*;

pub fn batch_convert_to_jpeg(buffers: Vec<Vec<u8>>, quality: u8) -> Vec<Result<Vec<u8>, String>> {
    buffers
        .into_iter()
        .map(|buffer| crate::image::convert_to_jpeg(&buffer, quality))
        .collect()
}

pub fn batch_apply_anti_censorship_jpeg(
    buffers: Vec<Vec<u8>>,
    noise_intensity: f32,
) -> Vec<Result<Vec<u8>, String>> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        use rayon::prelude::*;
        buffers
            .par_iter()
            .map(|buffer| {
                crate::anti_censorship::apply_anti_censorship_jpeg(
                    buffer,
                    noise_intensity,
                )
            })
            .collect()
    }

    #[cfg(target_arch = "wasm32")]
    {
        buffers
            .into_iter()
            .map(|buffer| {
                crate::anti_censorship::apply_anti_censorship_jpeg(
                    &buffer,
                    noise_intensity,
                )
            })
            .collect()
    }
}

// WASM 绑定辅助函数
pub fn wasm_batch_convert_to_jpeg(buffers: Vec<JsValue>, quality: u8) -> Vec<JsValue> {
    let rust_buffers: Vec<Vec<u8>> = buffers
        .into_iter()
        .map(|js_val| {
            let uint8_array = js_sys::Uint8Array::new(&js_val);
            uint8_array.to_vec()
        })
        .collect();

    batch_convert_to_jpeg(rust_buffers, quality)
        .into_iter()
        .map(|result| match result {
            Ok(data) => {
                let array = js_sys::Uint8Array::new_with_length(data.len() as u32);
                array.copy_from(&data);
                array.into()
            }
            Err(e) => JsValue::from_str(&format!("Error: {}", e)),
        })
        .collect()
}

pub fn wasm_batch_apply_anti_censorship_jpeg(
    buffers: Vec<JsValue>,
    noise_intensity: f32,
) -> Vec<JsValue> {
    let rust_buffers: Vec<Vec<u8>> = buffers
        .into_iter()
        .map(|js_val| {
            let uint8_array = js_sys::Uint8Array::new(&js_val);
            uint8_array.to_vec()
        })
        .collect();

    batch_apply_anti_censorship_jpeg(rust_buffers, noise_intensity)
        .into_iter()
        .map(|result| match result {
            Ok(data) => {
                let array = js_sys::Uint8Array::new_with_length(data.len() as u32);
                array.copy_from(&data);
                array.into()
            }
            Err(e) => JsValue::from_str(&format!("Error: {}", e)),
        })
        .collect()
}
