import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const [username, password, port, repo = ''] = process.argv.slice(2);
if (!username || !password || !port) {
  console.error('用法: node scripts/init-config.mjs <账号> <密码> <端口> [githubRepo]');
  process.exit(1);
}

const dataDir = path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });
const file = path.join(dataDir, 'config.json');
const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const next = {
  ...current,
  server: { ...(current.server || {}), port: Number(port) },
  auth: {
    username,
    passwordHash: bcrypt.hashSync(password, 10)
  },
  apiPool: current.apiPool || { globalRps: 20, timeoutMs: 10000, retries: 2, keys: [] },
  collector: current.collector || {
    pollIntervalMs: 60000,
    verifyIntervalMs: 300000,
    blockTimeMs: 12000,
    maxSubnets: 128
  },
  telegram: current.telegram || { enabled: false, botToken: '', chatId: '' },
  github: { ...(current.github || {}), repo }
};
fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
console.log('配置已写入 data/config.json');
