#!/usr/bin/env node
// Independent unpacked trees: FpmTarget must never mutate the AppImage input.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const assert = require('node:assert/strict');
const yaml = require('js-yaml');

function linuxNames(version) {
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  return {
    appimage: `Grok-Build-Desktop-${version}-linux-x86_64.AppImage`,
    deb: `Grok-Build-Desktop-${version}-linux-amd64.deb`,
  };
}

function mergeLinuxFeeds(appimage, deb, version) {
  const names = linuxNames(version);
  for (const [feed, name] of [[appimage, names.appimage], [deb, names.deb]]) {
    assert.equal(feed.version, version, 'channel version');
    assert.equal(feed.files?.length, 1, 'one artifact per isolated build');
    assert.equal(feed.files[0].url, name, 'channel artifact');
    assert.equal(feed.path, name, 'legacy path');
    assert.equal(feed.sha512, feed.files[0].sha512, 'legacy checksum');
  }
  // Retain builder metadata, hashes and sizes verbatim. Legacy clients must
  // always see the AppImage, irrespective of target completion order.
  return { ...appimage, files: [...appimage.files, ...deb.files] };
}

async function verifyLinuxFeed(dir, version) {
  const names = linuxNames(version);
  const feed = yaml.load(fs.readFileSync(path.join(dir, 'latest-linux.yml'), 'utf8'));
  assert.equal(feed.version, version);
  assert.equal(feed.path, names.appimage, 'latest-linux.yml path must be the AppImage');
  assert.deepEqual(feed.files.map(f => f.url).sort(), Object.values(names).sort());
  const artifacts = fs.readdirSync(dir).filter(n => /\.(AppImage|deb)$/.test(n)).sort();
  assert.deepEqual(artifacts, Object.values(names).sort(), 'exactly one AppImage and one deb');
  for (const file of feed.files) {
    const artifact = path.join(dir, file.url);
    assert.equal(fs.statSync(artifact).size, file.size, `${file.url}: size`);
    const hash = createHash('sha512');
    await pipeline(fs.createReadStream(artifact), hash);
    assert.equal(hash.digest('base64'), file.sha512, `${file.url}: sha512`);
  }
  assert.equal(feed.sha512, feed.files.find(f => f.url === names.appimage).sha512);
  console.log('latest-linux.yml: AppImage path; AppImage + deb files; sizes and sha512 verified');
  console.log(fs.readFileSync(path.join(dir, 'latest-linux.yml'), 'utf8'));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status ?? result.signal}`);
}

async function buildLinux(extraArgs) {
  assert.equal(process.platform, 'linux', 'dist:linux requires Linux');
  // The release workflow injects identity via extraMetadata. Reject options
  // that could collapse the two output directories or change targets/publish.
  for (const arg of extraArgs) assert.match(arg, /^-c\.extraMetadata\.[\w]+=/);
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'dist-desktop');
  const version = require('../package.json').version;
  const names = linuxNames(version);
  fs.mkdirSync(out, { recursive: true });
  for (const name of fs.readdirSync(out)) {
    if (/^Grok-Build-Desktop-.*-linux-.*\.(AppImage|deb)$/.test(name) || name === 'latest-linux.yml') {
      fs.unlinkSync(path.join(out, name));
    }
  }
  const staging = fs.mkdtempSync(path.join(out, 'linux-build-'));
  try {
    const feeds = [];
    for (const [target, name] of [['AppImage', names.appimage], ['deb', names.deb]]) {
      const targetDir = path.join(staging, target);
      run(process.execPath, [require.resolve('electron-builder/cli.js'),
        '--linux', target, '--x64', '--publish', 'never', ...extraArgs,
        // FpmTarget installs under /opt/${sanitizedProductName}; Chromium's
        // setuid-helper wrapper splits paths on spaces (#213).
        ...(target === 'deb' ? ['-c.productName=grok-build-desktop'] : []),
        '-c.extraMetadata.grokCloudBuild=true', `-c.directories.output=${targetDir}`,
      ], { cwd: root });
      feeds.push(yaml.load(fs.readFileSync(path.join(targetDir, 'latest-linux.yml'), 'utf8')));
      fs.copyFileSync(path.join(targetDir, name), path.join(out, name));
    }
    fs.writeFileSync(path.join(out, 'latest-linux.yml'), yaml.dump(mergeLinuxFeeds(...feeds, version), { lineWidth: -1 }));
    // A real squashfs inspection is mandatory on every dist:linux, including
    // local builds. The release gate repeats this against the upload inputs.
    run('bash', [path.join(root, 'scripts/verify-linux-deb.sh'), '--static', path.join(out, names.deb)]);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { linuxNames, mergeLinuxFeeds, verifyLinuxFeed };
if (require.main === module) {
  const args = process.argv.slice(2);
  const task = args[0] === '--verify-feed'
    ? verifyLinuxFeed(path.resolve(args[1]), args[2])
    : buildLinux(args);
  task.catch(error => { console.error(error); process.exitCode = 1; });
}
