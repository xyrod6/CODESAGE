#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

// Check if version is updated
console.log('Preparing to publish CODESAGE v' + packageJson.version);
console.log('======================================\n');

// Pre-publish checks
console.log('Running pre-publish checks...\n');

// 1. Check if dist directory exists and is built
try {
  execSync('test -d dist', { stdio: 'inherit' });
  console.log('✓ Build directory exists');
} catch {
  console.log('❌ Build directory not found. Running build...');
  execSync('npm run build', { stdio: 'inherit' });
  console.log('✓ Build completed');
}

// 2. Run tests
try {
  execSync('npm test', { stdio: 'inherit' });
  console.log('✓ All tests passed');
} catch {
  console.log('❌ Tests failed. Please fix tests before publishing.');
  process.exit(1);
}

// 3. Check if package is already published with this version
try {
  execSync(`npm view codesage@${packageJson.version}`, { stdio: 'ignore' });
  console.log(`❌ Version ${packageJson.version} is already published.`);
  console.log('Please update the version in package.json');
  process.exit(1);
} catch {
  console.log(`✓ Version ${packageJson.version} is new`);
}

// 4. Check git status
try {
  const gitStatus = execSync('git status --porcelain', { encoding: 'utf8' });
  if (gitStatus.trim()) {
    console.log('\n⚠️  You have uncommitted changes:');
    console.log(gitStatus);
    console.log('\nConsider committing these changes first.');
  } else {
    console.log('✓ Working directory is clean');
  }
} catch {
  console.log('⚠️  Not a git repository');
}

// Confirm publish
console.log('\nReady to publish to npm!');
console.log(`Package: codesage`);
console.log(`Version: ${packageJson.version}`);
console.log(`Registry: ${execSync('npm config get registry', { encoding: 'utf8' }).trim()}`);

// Ask for confirmation
process.stdout.write('\nPublish to npm? (y/N): ');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

let data = '';
process.stdin.on('data', (key) => {
  data += key;
  if (key.toLowerCase() === 'y') {
    console.log('\n\nPublishing...');
    try {
      execSync('npm publish', { stdio: 'inherit' });
      console.log('\n✅ Successfully published to npm!');
      console.log(`\nUsers can now install with: npm install -g codesage`);
    } catch (error) {
      console.error('\n❌ Publish failed:', error.message);
      if (error.stdout) console.error('STDOUT:', error.stdout);
      if (error.stderr) console.error('STDERR:', error.stderr);
    }
  } else if (key === '\u0003' || key.toLowerCase() === 'n') {
    console.log('\n\nPublish cancelled.');
  }
  process.exit(0);
});