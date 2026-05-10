import { RateLimiter } from './rateLimiter.js';

let rpcId = 1;

export function normalizeEndpoint(key) {
  if (key.endpoint) return key.endpoint.trim();
  if (key.apiKey) return `https://api-bittensor-mainnet.n.dwellir.com/${key.apiKey.trim()}`;
  return '';
}

export function toWsEndpoint(endpoint) {
  return endpoint.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
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
