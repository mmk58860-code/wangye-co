import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppLogger } from './logger.js';
import { DwellirPool, extractDwellirApiKey, normalizeEndpoint } from './dwellirPool.js';
import { BittensorMonitor } from './bittensorMonitor.js';
import { Notifier } from './notifier.js';
import { checkPassword, publicConfig, requireAuth } from './auth.js';
import { loadConfig, saveConfig } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');
let config = loadConfig();
const logger = new AppLogger();
const getConfig = () => config;
const pool = new DwellirPool(getConfig, logger);
const notifier = new Notifier(getConfig, logger);
const monitor = new BittensorMonitor({ pool, getConfig, logger, notifier });
const app = express();

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(session({
  name: 'wangye.sid',
  secret: process.env.SESSION_SECRET || 'wangye-co-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.post('/api/login', async (req, res) => {
  const ok = await checkPassword(config, req.body.username, req.body.password);
  if (!ok) {
    logger.warn('网页登录失败', { username: req.body.username });
    res.status(401).json({ error: '账号或密码错误' });
    return;
  }
  req.session.user = { username: config.auth.username };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session?.user || null });
});

app.get('/api/dashboard', requireAuth, (req, res) => {
  res.json(monitor.snapshot(req.query.sort || 'netuid'));
});

app.get('/api/race', requireAuth, (req, res) => {
  res.json(monitor.snapshot().race);
});

app.get('/api/logs', requireAuth, (req, res) => {
  res.json(logger.list({ q: req.query.q, level: req.query.level, limit: req.query.limit || 500 }));
});

app.get('/api/settings', requireAuth, (req, res) => {
  res.json(publicConfig(config));
});

app.put('/api/settings', requireAuth, (req, res) => {
  const next = sanitizeSettings(config, req.body);
  config = next;
  saveConfig(config);
  monitor.schedule();
  logger.info('系统设置已更新', { username: req.session.user.username });
  res.json(publicConfig(config));
});

app.post('/api/password', requireAuth, async (req, res) => {
  if (!req.body.password || String(req.body.password).length < 8) {
    res.status(400).json({ error: '密码至少 8 位' });
    return;
  }
  config.auth.username = req.body.username || config.auth.username;
  config.auth.passwordHash = await bcrypt.hash(req.body.password, 10);
  saveConfig(config);
  logger.info('网页账号密码已更新');
  res.json({ ok: true });
});

app.post('/api/refresh', requireAuth, async (req, res) => {
  res.json(await monitor.refresh('手动刷新'));
});

app.get('/api/events', requireAuth, (req, res) => {
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('state', monitor.snapshot());
  const offState = monitor.onUpdate((payload) => send(payload.type, payload.data));
  const offLog = logger.on((entry) => send('log', entry));
  const ping = setInterval(() => send('ping', { ts: Date.now() }), 25000);
  req.on('close', () => {
    clearInterval(ping);
    offState();
    offLog();
  });
});

app.use(express.static(publicDir));
app.get(/.*/, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

const port = Number(process.env.PORT || config.server.port || 3000);
app.listen(port, () => {
  logger.info(`wangye-co 已启动，端口 ${port}`);
  monitor.start().catch((error) => logger.warn('采集器启动失败', { error: error.message }));
});

function sanitizeSettings(current, body) {
  const next = structuredClone(current);
  if (body.apiPool) {
    next.apiPool.globalRps = clamp(body.apiPool.globalRps, 1, 10000, current.apiPool.globalRps);
    next.apiPool.timeoutMs = clamp(body.apiPool.timeoutMs, 1000, 120000, current.apiPool.timeoutMs);
    next.apiPool.retries = clamp(body.apiPool.retries, 0, 10, current.apiPool.retries);
    next.apiPool.keys = (body.apiPool.keys || []).map((key, index) => {
      const prior = current.apiPool.keys?.find((old) => old.id === key.id) || {};
      const incoming = key.endpoint && !key.endpoint.includes('******')
        ? key.endpoint
        : (key.apiKey && !key.apiKey.includes('******') ? key.apiKey : '');
      const apiKey = extractDwellirApiKey(incoming) || prior.apiKey || extractDwellirApiKey(prior.endpoint);
      const endpoint = apiKey ? normalizeEndpoint({ apiKey }) : (prior.endpoint || '');
      return {
        id: key.id || `api-${Date.now()}-${index}`,
        name: key.name || `API ${index + 1}`,
        enabled: key.enabled !== false,
        endpoint,
        apiKey,
        perSecondLimit: clamp(key.perSecondLimit, 1, 10000, prior.perSecondLimit || 20)
      };
    });
  }
  if (body.collector) {
    next.collector.pollIntervalMs = clamp(body.collector.pollIntervalMs, 10000, 3600000, current.collector.pollIntervalMs);
    next.collector.verifyIntervalMs = clamp(body.collector.verifyIntervalMs, 30000, 3600000, current.collector.verifyIntervalMs);
    next.collector.blockTimeMs = clamp(body.collector.blockTimeMs, 1000, 60000, current.collector.blockTimeMs);
    next.collector.maxSubnets = clamp(body.collector.maxSubnets, 1, 1024, current.collector.maxSubnets);
  }
  if (body.telegram) {
    next.telegram.enabled = Boolean(body.telegram.enabled);
    next.telegram.botToken = body.telegram.botToken && !body.telegram.botToken.includes('******')
      ? String(body.telegram.botToken).trim()
      : current.telegram.botToken;
    next.telegram.chatId = body.telegram.chatId !== undefined ? String(body.telegram.chatId).trim() : current.telegram.chatId;
  }
  if (body.github) {
    next.github.repo = body.github.repo || current.github.repo;
    next.github.branch = body.github.branch || current.github.branch || 'main';
  }
  return next;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
