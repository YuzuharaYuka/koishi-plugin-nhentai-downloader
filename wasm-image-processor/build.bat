@echo off
REM Build script for wasm-image-processor: High-performance image processing WASM module

echo.
echo  Building WASM image processor...
echo.

where wasm-pack >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo  wasm-pack is not installed!
    exit /b 1
)

for /f "tokens=*" %%i in ('rustc --version') do set RUST_VER=%%i
for /f "tokens=*" %%i in ('wasm-pack --version') do set WASM_VER=%%i
echo  Tools: %RUST_VER% ^| %WASM_VER%
echo.

echo  Compiling to WASM (Node.js target)...
set RUSTFLAGS=-C target-feature=+simd128
wasm-pack build --target nodejs --release --out-dir ../wasm-dist

if %ERRORLEVEL% EQU 0 (
    echo.
    echo  Build complete!
    if exist "..\wasm-dist\wasm_image_processor_bg.wasm" (
        echo  WASM ready at: wasm-dist/
    )
) else (
    echo.
    echo  Build failed! Try: cargo clean ^&^& build.bat
    exit /b 1
)
