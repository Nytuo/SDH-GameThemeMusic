const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const OUT_DIR = path.join(__dirname, 'out');
const DIST_DIR = path.join(__dirname, 'dist');
const FILES_TO_COPY = [
  'main.py',
  'package.json',
  'plugin.json',
  'README.md',
  'LICENSE'
];

function cleanOutDir() {
  if (fs.existsSync(OUT_DIR)) {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUT_DIR);
}

function buildRollup() {
  execSync('pnpm run build', { stdio: 'inherit' });
}

function copyDist() {
  if (fs.existsSync(DIST_DIR)) {
    const dest = path.join(OUT_DIR, 'dist');
    fs.cpSync(DIST_DIR, dest, { recursive: true });
  } else {
    console.error('dist/ directory not found. Did the build succeed?');
    process.exit(1);
  }
}

function copyFiles() {
  for (const file of FILES_TO_COPY) {
    const src = path.join(__dirname, file);
    const dest = path.join(OUT_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    } else {
      console.warn(`${file} not found, skipping.`);
    }
  }
}

function main() {
  cleanOutDir();
  buildRollup();
  copyDist();
  copyFiles();
  console.log('Build output prepared in out/');
}

main();
