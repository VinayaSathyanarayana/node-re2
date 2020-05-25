'use strict';

const {promises: fsp} = require('fs');
const path = require('path');
const zlib = require('zlib');
const {promisify} = require('util');
const https = require('https');
const {exec} = require('child_process');

const pkg = require('../package.json');

const getParam = (name, defaultValue = '') => {
  const index = process.argv.indexOf('--' + name);
  if (index > 0) return process.argv[index + 1] || '';
  return defaultValue;
};

const artifactPath = getParam('artifact'),
  prefix = getParam('prefix'),
  suffix = getParam('suffix');

const parseUrl = /^(?:https?|git|git\+https):\/\/github.com\/([^\/]+)\/([^\/\.]+)(?:\/|\.git\b|$)/i;

const getAssetUrlPrefix = pkg => {
  const url = pkg.github || (pkg.repository && pkg.repository.type === 'git' && pkg.repository.url),
    result = parseUrl.exec(url);
  return (
    result &&
    `https://github.com/${result[1]}/${result[2]}/releases/download/${'v5.5.5' || pkg.version}/${prefix}${process.platform}-${process.arch}-${
      process.versions.modules
    }${suffix}`
  );
};

const isDev = async () => {
  try {
    await fsp.access(path.join(__dirname, '../.development'));
    return true;
  } catch (e) {
    // squelch
  }
  return false;
};

const run = async cmd =>
  new Promise((resolve, reject) => {
    const p = exec(cmd);
    p.stdout.on('data', data => process.stdout.write(data));
    p.stderr.on('data', data => process.stderr.write(data));
    p.on('close', code => (code ? reject : resolve)(code));
    p.on('error', error => reject(error));
  });

const isVerified = async () => {
  try {
    await run('npm run verify-build');
    return true;
  } catch (e) {
    // squelch
  }
  return false;
};

const get = async url =>
  new Promise((resolve, reject) => {
    let buffer = null;
    https
      .get(url, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers && res.headers.location) {
          get(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode != 200) {
          reject(Error(`Status ${res.statusCode} for ${url}`));
          return;
        }
        res.on('data', data => {
          if (buffer) {
            buffer = Buffer.concat([buffer, data]);
          } else {
            buffer = data;
          }
        });
        res.on('end', () => resolve(buffer));
      })
      .on('error', e => reject(e));
  });

const write = async (name, data) => {
  await fsp.mkdir(path.dirname(name), {recursive: true});
  await fsp.writeFile(name, data);
};

const main = async () => {
  checks: {
    if (!artifactPath) {
      console.log('No artifact path was specified with --artifact.');
      break checks;
    }
    if (await isDev()) {
      console.log('Development flag was detected.');
      break checks;
    }
    const prefix = getAssetUrlPrefix(pkg);
    if (!prefix) {
      console.log('No github repository was identified.');
      break checks;
    }
    let copied = false;
    // let's try brotli
    if (zlib.brotliDecompress) {
      try {
        console.log(`Trying ${prefix}.br ...`);
        const artifact = await get(prefix + '.br');
        console.log(`Writing to ${artifactPath} ...`);
        await write(artifactPath, await promisify(zlib.brotliDecompress)(artifact));
        copied = true;
      } catch (e) {
        // squelch
      }
    }
    // let's try gzip
    if (!copied && zlib.gunzip) {
      try {
        console.log(`Trying ${prefix}.gz ...`);
        const artifact = await get(prefix + '.gz');
        console.log(`Writing to ${artifactPath} ...`);
        await write(artifactPath, await promisify(zlib.gunzip)(artifact));
        copied = true;
      } catch (e) {
        // squelch
      }
    }
    // verify the install
    if (copied && (await isVerified())) return console.log('Done.');
  }
  console.log('Building locally ...');
  await run('npm run rebuild');
};
main();