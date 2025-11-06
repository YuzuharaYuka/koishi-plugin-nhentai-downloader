@echo off
REM Build script for wasm-image-processor (Windows)

echo.
echo Building WASM image processor...
echo.

REM Check if wasm-pack is installed
where wasm-pack >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Error: wasm-pack is not installed!
    exit /b 1
)

REM Enable SIMD128 optimization and getrandom wasm_js backend
set RUSTFLAGS=-C target-feature=+simd128 --cfg getrandom_backend="wasm_js"

wasm-pack build --target nodejs --release --out-dir ../wasm-dist

if %ERRORLEVEL% EQU 0 (
    echo Build complete!
) else (
    echo Build failed!
    exit /b 1
)
