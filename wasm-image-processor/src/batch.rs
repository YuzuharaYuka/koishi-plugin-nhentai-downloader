// src/batch.rs - 批处理模块

use wasm_bindgen::prelude::*;

const ERROR_PREFIX: &str = "Error: ";

// 将 JS Uint8Array 数组转换为 Rust Vec<u8> 数组
fn js_values_to_rust_buffers(js_buffers: Vec<JsValue>) -> Vec<Vec<u8>> {
    js_buffers
        .into_iter()
        .map(|js_val| js_sys::Uint8Array::new(&js_val).to_vec())
        .collect()
}

// 将处理结果转换为 JS Uint8Array 或错误字符串
fn rust_results_to_js_values(results: Vec<Result<Vec<u8>, String>>) -> Vec<JsValue> {
    results
        .into_iter()
        .map(|result| match result {
            Ok(data) => {
                let array = js_sys::Uint8Array::new_with_length(data.len() as u32);
                array.copy_from(&data);
                array.into()
            }
            Err(e) => JsValue::from_str(&format!("{}{}", ERROR_PREFIX, e)),
        })
        .collect()
}

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
    // 通用处理逻辑：非 WASM 环境用 rayon 并行，WASM 环境用串行
    #[cfg(not(target_arch = "wasm32"))]
    {
        use rayon::prelude::*;
        buffers.par_iter().map(|buffer| {
            crate::anti_censorship::apply_anti_censorship_jpeg(buffer, noise_intensity)
        }).collect()
    }

    #[cfg(target_arch = "wasm32")]
    {
        buffers.into_iter().map(|buffer| {
            crate::anti_censorship::apply_anti_censorship_jpeg(&buffer, noise_intensity)
        }).collect()
    }
}

// WASM 绑定辅助：处理批量 JPEG 转换
pub fn wasm_batch_convert_to_jpeg(buffers: Vec<JsValue>, quality: u8) -> Vec<JsValue> {
    let rust_buffers = js_values_to_rust_buffers(buffers);
    let results = batch_convert_to_jpeg(rust_buffers, quality);
    rust_results_to_js_values(results)
}

pub fn wasm_batch_apply_anti_censorship_jpeg(
    buffers: Vec<JsValue>,
    noise_intensity: f32,
) -> Vec<JsValue> {
    let rust_buffers = js_values_to_rust_buffers(buffers);
    let results = batch_apply_anti_censorship_jpeg(rust_buffers, noise_intensity);
    rust_results_to_js_values(results)
}
