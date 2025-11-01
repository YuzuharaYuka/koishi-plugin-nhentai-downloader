@echo off
REM Build script for wasm-image-processor (Windows)
REM High-performance Rust WASM module for image processing

echo.
echo Building WASM image processor...
echo.

REM Check if wasm-pack is installed
where wasm-pack >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Error: wasm-pack is not installed!
    echo.
    echo Install it with:
    echo   cargo install wasm-pack
    echo.
    exit /b 1
)

REM Check if cargo is installed
where cargo >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Error: Rust/Cargo is not installed!
    echo.
    echo Install it from: https://rustup.rs/
    echo.
    exit /b 1
)

REM Display versions
echo Tool versions:
rustc --version
cargo --version
wasm-pack --version
echo.

REM Build for Node.js target with optimizations
echo Compiling Rust to WASM (Node.js target)...
echo.

wasm-pack build --target nodejs --release --out-dir ../wasm-dist

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Build complete!
    echo.

    REM Display package size
    if exist "..\wasm-dist\wasm_image_processor_bg.wasm" (
        for %%A in ("..\wasm-dist\wasm_image_processor_bg.wasm") do (
            set SIZE=%%~zA
            set /a SIZE_KB=!SIZE! / 1024
            echo WASM binary size: !SIZE_KB! KB
        )
    )

    echo.
    echo WASM module is ready to use!
    echo   Location: wasm-dist\
    echo.
    echo Next steps:
    echo   1. Run tests: npm test
    echo   2. Build plugin: npm run build
    echo.
) else (
    echo.
    echo Build failed!
    echo.
    echo Common issues:
    echo   1. Run: rustup target add wasm32-unknown-unknown
    echo   2. Check Cargo.toml for errors
    echo   3. Try: cargo clean ^&^& build.bat
    echo   4. Install Visual Studio Build Tools if needed
    echo.
    exit /b 1
)
