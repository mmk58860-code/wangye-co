import { RateLimiter } from './rateLimiter.js';

let rpcId = 1;
const DWELLIR_HTTP_BASE = 'https://api-bittensor-mainnet.n.dwellir.com';

export function normalizeEndpoint(key) {
  const raw = key.endpoint || key.apiKey || '';
  const apiKey = extractDwellirApiKey(raw);
  if (apiKey) return `${DWELLIR_HTTP_BASE}/${apiKey}`;
  if (key.endpoint) return String(key.endpoint).trim().replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  return '';
}

export function toWsEndpoint(endpoint) {
  return endpoint.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

export function extractDwellirApiKey(value = '') {
  const text = String(value).trim();
  if (!text || text.includes('******')) return '';
  const uuid = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (uuid) return uuid[0];
  try {
    const urlMatch = text.match(/(?:https?|wss?):\/\/[^\s]+/i);
    const url = new URL(urlMatch ? urlMatch[0] : text);
    const last = url.pathname.split('/').filter(Boolean).pop();
    return last && !last.includes('*') ? last.trim() : '';
  } catch {
    return text.replace(/^\/+|\/+$/g, '');
  }
}

export class DwellirPool {
  constructor(getConfig, logger) {
    this.getConfig = getConfig;
    this.logger = logger;
    this.globalLimiter = new RateLimiter(20);
    this.keyLimiters = new Map();
    this.cursor = 0;
  }

  enabledKeys() {
    const cfg = this.getConfig().apiPool || {};
    this.globalLimiter.setRate(cfg.globalRps || 20);
    return (cfg.keys || [])
      .filter((key) => key.enabled !== false && normalizeEndpoint(key))
      .map((key, index) => ({
        ...key,
        id: key.id || `key-${index}`,
        endpoint: normalizeEndpoint(key),
        perSecondLimit: Number(key.perSecondLimit || 20)
      }));
  }

  nextKey() {
    const keys = this.enabledKeys();
    if (!keys.length) throw new Error('还没有配置可用的 Dwellir API');
    const key = keys[this.cursor % keys.length];
    this.cursor += 1;
    if (!this.keyLimiters.has(key.id)) this.keyLimiters.set(key.id, new RateLimiter(key.perSecondLimit));
    this.keyLimiters.get(key.id).setRate(key.perSecondLimit);
    return key;
  }

  firstWsEndpoint() {
    return toWsEndpoint(this.nextKey().endpoint);
  }

  async rpc(method, params = []) {
    const cfg = this.getConfig().apiPool || {};
    const retries = Number(cfg.retries ?? 2);
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const key = this.nextKey();
      await this.globalLimiter.take();
      await this.keyLimiters.get(key.id).take();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(cfg.timeoutMs || 10000));
      try {
        const res = await fetch(key.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        if (payload.error) throw new Error(payload.error.message || JSON.stringify(payload.error));
        return payload.result;
      } catch (error) {
        lastError = error;
        this.logger.warn('Dwellir RPC 请求失败，准备重试', { method, attempt, error: error.message });
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }
}
