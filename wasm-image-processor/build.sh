#!/bin/bash

# Build script for wasm-image-processor: High-performance image processing WASM module

set -e

echo " Building WASM image processor..."

# Check required tools
check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo " $2 is not installed!"
        return 1
    fi
}

check_command "cargo" "Rust/Cargo" || exit 1
check_command "wasm-pack" "wasm-pack" || exit 1

# Display versions
echo " Tools: $(rustc --version) | $(cargo --version) | $(wasm-pack --version)"
echo ""

# Build with SIMD128 optimization
echo " Compiling to WASM (Node.js target)..."
export RUSTFLAGS="-C target-feature=+simd128"

wasm-pack build --target nodejs --release --out-dir ../wasm-dist

if [ $? -eq 0 ]; then
    echo " Build complete!"
    [ -f "../wasm-dist/wasm_image_processor_bg.wasm" ] && echo " WASM ready at: wasm-dist/"
else
    echo " Build failed! Try: cargo clean && ./build.sh"
    exit 1
fi

