const fs = require('fs');
const path = require('path');

const wasmGitignorePath = path.join(__dirname, '../wasm-dist/.gitignore');

if (fs.existsSync(wasmGitignorePath)) {
  fs.unlinkSync(wasmGitignorePath);
  console.log('✓ 已删除 wasm-dist/.gitignore');
} else {
  console.log('✓ wasm-dist/.gitignore 不存在，无需删除');
}
