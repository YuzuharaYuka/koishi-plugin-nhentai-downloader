#!/bin/bash

# Build script for wasm-image-processor
# High-performance Rust WASM module for image processing

set -e

echo "🦀 Building WASM image processor..."
echo ""

# Check if wasm-pack is installed
if ! command -v wasm-pack &> /dev/null; then
    echo "❌ wasm-pack is not installed!"
    echo ""
    echo "Install it with:"
    echo "  cargo install wasm-pack"
    echo ""
    exit 1
fi

# Check if cargo is installed
if ! command -v cargo &> /dev/null; then
    echo "❌ Rust/Cargo is not installed!"
    echo ""
    echo "Install it with:"
    echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    echo ""
    exit 1
fi

# Display versions
echo "📦 Tool versions:"
rustc --version
cargo --version
wasm-pack --version
echo ""

# Build for Node.js target with optimizations
echo "🔨 Compiling Rust to WASM (Node.js target)..."
echo ""

wasm-pack build \
    --target nodejs \
    --release \
    --out-dir ../wasm-dist

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Build complete!"
    echo ""

    # Display package size
    if [ -f "../wasm-dist/wasm_image_processor_bg.wasm" ]; then
        if command -v stat &> /dev/null; then
            if [[ "$OSTYPE" == "darwin"* ]]; then
                SIZE=$(stat -f%z "../wasm-dist/wasm_image_processor_bg.wasm")
            else
                SIZE=$(stat -c%s "../wasm-dist/wasm_image_processor_bg.wasm")
            fi
            SIZE_KB=$((SIZE / 1024))
            echo "📊 WASM binary size: ${SIZE_KB} KB"
        fi
    fi

    echo ""
    echo "🎉 WASM module is ready to use!"
    echo "   Location: wasm-dist/"
    echo ""
    echo "Next steps:"
    echo "  1. Run tests: npm test"
    echo "  2. Build plugin: npm run build"
    echo ""
else
    echo ""
    echo "❌ Build failed!"
    echo ""
    echo "Common issues:"
    echo "  1. Run: rustup target add wasm32-unknown-unknown"
    echo "  2. Check Cargo.toml for errors"
    echo "  3. Try: cargo clean && ./build.sh"
    echo ""
    exit 1
fi
