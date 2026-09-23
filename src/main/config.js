'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:3080',
  lastToken: '',
  workspace: '',
  dshHome: process.env.DSH_HOME || '',
  dshCommand: '',
  alwaysOnTop: false,
  port: 0, // 0 = 交给 dsh 自动选择
  windowBounds: undefined,
};

let cache;

function configPath() {
  return path.join(app.getPath('userData'), 'desktop-config.json');
}

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    stored = {};
  }
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

function save(patch) {
  const next = { ...load(), ...patch };
  cache = next;
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(next, null, 2));
  } catch (error) {
    // 配置写失败不致命，仅记录
    console.error('desktop-config: failed to persist', error);
  }
  return next;
}

module.exports = { load, save, configPath, DEFAULTS };