#!/usr/bin/env node
/**
 * Pre-build validation for Meetily Tauri/DMG build.
 * Run before tauri build to catch common issues.
 */

const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const srcTauri = path.join(projectRoot, 'src-tauri');
let failed = false;

function warn(msg) {
  console.warn('⚠️  ' + msg);
}

function error(msg) {
  console.error('❌ ' + msg);
  failed = true;
}

function ok(msg) {
  console.log('✅ ' + msg);
}

console.log('\n🔍 Meetily pre-build validation\n');

// 1. Check tauri.conf.json exists and has required fields
const tauriConfPath = path.join(srcTauri, 'tauri.conf.json');
if (!fs.existsSync(tauriConfPath)) {
  error('tauri.conf.json not found at ' + tauriConfPath);
} else {
  ok('tauri.conf.json found');
  try {
    const conf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
    if (!conf.identifier || conf.identifier !== 'com.meetily.ai') {
      warn('identifier in tauri.conf.json should be com.meetily.ai (found: ' + (conf.identifier || 'missing') + ')');
    } else {
      ok('Bundle identifier: ' + conf.identifier);
    }
    if (!conf.plugins?.['deep-link']?.desktop?.schemes?.includes('meetily')) {
      warn('URL scheme "meetily" should be registered under plugins.deep-link.desktop.schemes');
    } else {
      ok('URL scheme meetily registered');
    }
    if (!conf.bundle?.targets?.includes('dmg')) {
      warn('DMG not in bundle targets; add "dmg" for macOS disk image');
    } else {
      ok('DMG in bundle targets');
    }
  } catch (e) {
    error('Invalid tauri.conf.json: ' + e.message);
  }
}

// 2. Check macOS entitlements
const entitlementsPath = path.join(srcTauri, 'entitlements.plist');
if (!fs.existsSync(entitlementsPath)) {
  error('entitlements.plist not found (required for macOS DMG)');
} else {
  ok('entitlements.plist found');
  const plist = fs.readFileSync(entitlementsPath, 'utf8');
  if (!plist.includes('microphone') && !plist.includes('audio-input')) {
    warn('entitlements.plist should include microphone/audio-input for recording');
  }
  if (!plist.includes('screen-capture')) {
    warn('entitlements.plist should include screen-capture for system audio');
  }
}

// 3. Check beforeBuildCommand will succeed (next build)
const outDir = path.join(projectRoot, 'out');
const nextBuildMarker = path.join(projectRoot, '.next', 'BUILD_ID');
if (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
  error('package.json not found in frontend directory');
} else {
  ok('Frontend package.json present');
}

// 4. Rust/Cargo
const cargoToml = path.join(srcTauri, 'Cargo.toml');
if (!fs.existsSync(cargoToml)) {
  error('Cargo.toml not found in src-tauri');
} else {
  ok('Cargo.toml found');
}

console.log('');
if (failed) {
  console.error('Pre-build validation failed. Fix the errors above and try again.\n');
  process.exit(1);
}
console.log('Pre-build validation passed.\n');
process.exit(0);
