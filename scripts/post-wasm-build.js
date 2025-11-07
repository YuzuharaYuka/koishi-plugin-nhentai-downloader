// Post-build hook: Remove wasm-pack generated .gitignore to allow WASM dist publishing
const fs = require('fs');
const path = require('path');

const wasmGitignorePath = path.join(__dirname, '../wasm-dist/.gitignore');
try {
  if (fs.existsSync(wasmGitignorePath)) {
    fs.unlinkSync(wasmGitignorePath);
    console.log('✓ Removed wasm-dist/.gitignore for publishing');
  }
} catch (err) {
  console.warn('⚠ Failed to remove .gitignore:', err.message);
}
