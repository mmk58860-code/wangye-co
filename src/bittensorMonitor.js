import { ApiPromise, WsProvider } from '@polkadot/api';
import { PythonCollector } from './pythonCollector.js';
import { blocksToDuration } from './time.js';

const ZERO_STATE = {
  status: 'waiting',
  updatedAt: null,
  currentBlock: 0,
  registrationCost: null,
  immunityPeriod: null,
  subnets: Array.from({ length: 128 }, (_, i) => ({
    netuid: i + 1,
    name: `Subnet ${i + 1}`,
    alphaPrice: null,
    registrationCost: null,
    emaPrice: null,
    volume1h: null,
    volume24h: null,
    registrationBlock: null,
    immunityPeriod: null,
    inImmunity: false,
    raceEligible: false,
    riskLevel: 'unknown'
  })),
  race: {},
  chainFlow: {
    stakeAlphaEvents24h: 0,
    unstakeAlphaEvents24h: 0,
    recent: []
  },
  lastAlert: null,
  errors: []
};

export class BittensorMonitor {
  constructor({ pool, getConfig, logger, notifier }) {
    this.pool = pool;
    this.getConfig = getConfig;
    this.logger = logger;
    this.notifier = notifier;
    this.python = new PythonCollector(pool, getConfig, logger);
    this.state = structuredClone(ZERO_STATE);
    this.clients = new Set();
    this.pollTimer = null;
    this.verifyTimer = null;
    this.api = null;
    this.lastNetuids = new Set();
    this.volumeHistory = new Map();
    this.refreshPromise = null;
  }

  onUpdate(listener) {
    this.clients.add(listener);
    return () => this.clients.delete(listener);
  }

  emit(type = 'state') {
    const payload = { type, data: this.snapshot() };
    for (const client of this.clients) client(payload);
  }

  snapshot(sort = 'netuid') {
    const subnets = [...this.state.subnets].sort((a, b) => compareSubnets(a, b, sort));
    return { ...this.state, subnets };
  }

  async start() {
    await this.refresh('启动采集');
    this.schedule();
    this.connectWs().catch((error) => this.logger.warn('新区块订阅启动失败', { error: error.message }));
  }

  schedule() {
    clearInterval(this.pollTimer);
    clearInterval(this.verifyTimer);
    const cfg = this.getConfig().collector;
    this.pollTimer = setInterval(() => this.refresh('定时采集').catch((e) => this.recordError(e)), cfg.pollIntervalMs || 60000);
    this.verifyTimer = setInterval(() => this.verifySubnetList().catch((e) => this.recordError(e)), cfg.verifyIntervalMs || 300000);
  }

  async refresh(reason = '手动刷新') {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.doRefresh(reason).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async doRefresh(reason = '手动刷新') {
    try {
      const data = await this.collect();
      this.applyCollected(data);
      this.logger.info(`${reason}完成`, {
        block: this.state.currentBlock,
        subnetCount: this.state.race.currentSubnetCount
      });
      this.emit('refresh');
    } catch (error) {
      this.recordError(error);
      this.state.status = 'degraded';
      this.emit('error');
    }
    return this.snapshot();
  }

  async collect() {
    try {
      return await this.collectViaRpc();
    } catch (rpcError) {
      this.logger.warn('Dwellir RPC 全量采集失败，尝试 Python SDK', { error: rpcError.message });
      const data = await this.python.collect();
      const prune = await this.pool.rpc('subnetInfo_getSubnetToPrune').catch(() => null);
      if (data.nextPruneCandidate == null && prune != null) data.nextPruneCandidate = parseMaybeNumber(prune);
      return data;
    }
  }

  async collectViaRpc() {
    const [header, dynamicInfo, lockCost, prune] = await Promise.all([
      this.pool.rpc('chain_getHeader').catch(() => null),
      this.pool.rpc('subnetInfo_getAllDynamicInfo'),
      this.pool.rpc('subnetInfo_getLockCost').catch(() => null),
      this.pool.rpc('subnetInfo_getSubnetToPrune').catch(() => null)
    ]);
    if (!Array.isArray(dynamicInfo)) {
      throw new Error('subnetInfo_getAllDynamicInfo 返回 SCALE 原始数据，改用 Python SDK 解码');
    }
    const rawItems = dynamicInfo;
    if (rawItems.some((item) => !item || typeof item !== 'object')) {
      throw new Error('subnetInfo_getAllDynamicInfo 返回结构无法直接解析，改用 Python SDK 解码');
    }
    if (!rawItems.length) throw new Error('subnetInfo_getAllDynamicInfo 返回为空');
    const subnets = rawItems.map((item) => normalizeRpcSubnet(item)).filter(Boolean);
    return {
      currentBlock: parseMaybeNumber(header?.number) || this.state.currentBlock,
      registrationCost: asNumber(lockCost),
      immunityPeriod: subnets.find((s) => s.immunityPeriod != null)?.immunityPeriod ?? null,
      nextPruneCandidate: parseMaybeNumber(prune),
      subnets
    };
  }

  applyCollected(data) {
    const cfg = this.getConfig().collector;
    const subnets = normalizeSubnets(this.decorateVolumes(data.subnets || []), data.registrationCost, data.immunityPeriod, data.currentBlock, cfg);
    const ranked = [...subnets].filter((s) => s.raceEligible).sort((a, b) => num(a.emaPrice, Infinity) - num(b.emaPrice, Infinity));
    const immune = subnets.filter((s) => s.inImmunity).sort((a, b) => num(a.immunityEndsAtBlock, 0) - num(b.immunityEndsAtBlock, 0));
    const netuids = new Set(subnets.map((s) => Number(s.netuid)));
    this.detectListDiff(netuids);
    this.lastNetuids = netuids;
    this.state = {
      status: 'ok',
      updatedAt: new Date().toISOString(),
      currentBlock: data.currentBlock || this.state.currentBlock,
      registrationCost: data.registrationCost ?? null,
      immunityPeriod: data.immunityPeriod ?? null,
      subnets,
      race: {
        currentSubnetCount: subnets.length,
        maxSubnets: cfg.maxSubnets || 128,
        atLimit: subnets.length >= (cfg.maxSubnets || 128),
        registrationCost: data.registrationCost ?? null,
        immunityPeriod: data.immunityPeriod ?? null,
        currentBlock: data.currentBlock || null,
        nextPruneCandidate: data.nextPruneCandidate ?? ranked[0]?.netuid ?? null,
        nonImmuneCount: subnets.filter((s) => s.raceEligible).length,
        lowestEmaRanking: ranked.slice(0, 10).map((s, index) => ({ rank: index + 1, netuid: s.netuid, name: s.name, emaPrice: s.emaPrice })),
        immuneSubnets: immune.map((s) => ({
          netuid: s.netuid,
          name: s.name,
          registrationBlock: s.registrationBlock,
          immunityEndsAtBlock: s.immunityEndsAtBlock,
          remainingBlocks: s.remainingImmunityBlocks,
          remainingText: blocksToDuration(s.remainingImmunityBlocks || 0, cfg.blockTimeMs)
        }))
      },
      chainFlow: this.prunedChainFlow(),
      lastAlert: this.state.lastAlert,
      errors: this.state.errors.slice(-10)
    };
  }

  decorateVolumes(items) {
    const now = Date.now();
    const cutoff = now - 25 * 60 * 60 * 1000;
    return items.map((item) => {
      const netuid = Number(item.netuid ?? item.netUID ?? item.uid ?? item.id);
      const rawVolume = nullableNumber(item.rawVolume ?? item.cumulativeVolume);
      if (Number.isFinite(netuid) && rawVolume != null) {
        const history = (this.volumeHistory.get(netuid) || []).filter((point) => point.ts >= cutoff);
        history.push({ ts: now, value: rawVolume });
        this.volumeHistory.set(netuid, history);
        return {
          ...item,
          volume1h: item.volume1h ?? deltaSince(history, now - 60 * 60 * 1000),
          volume24h: item.volume24h ?? deltaSince(history, now - 24 * 60 * 60 * 1000)
        };
      }
      return item;
    });
  }

  async connectWs() {
    if (this.api) {
      await this.api.disconnect();
      this.api = null;
    }
    const endpoint = this.pool.firstWsEndpoint();
    const provider = new WsProvider(endpoint, 5000);
    this.api = await ApiPromise.create({ provider, throwOnConnect: false });
    await this.api.rpc.chain.subscribeNewHeads(async (header) => {
      const blockNumber = header.number.toNumber();
      this.state.currentBlock = blockNumber;
      this.emit('head');
      try {
        const hash = await this.api.rpc.chain.getBlockHash(blockNumber);
        const events = await this.api.query.system.events.at(hash);
        await this.handleEvents(blockNumber, events);
      } catch (error) {
        this.logger.warn('读取新区块 events 失败', { blockNumber, error: error.message });
      }
    });
    this.logger.info('已订阅 Bittensor 新区块头', { endpoint: maskEndpoint(endpoint) });
  }

  async handleEvents(blockNumber, events) {
    for (const record of events) {
      const { event } = record;
      const section = event.section || '';
      const method = event.method || '';
      const text = `${section}.${method}`;
      if (/subtensor/i.test(section) && /(register|deregister|subnet|network|prune)/i.test(method)) {
        const payload = {
          blockNumber,
          event: text,
          data: event.data?.toHuman?.() || event.data?.toString?.()
        };
        this.state.lastAlert = payload;
        await this.notifier.alert(`区块 ${blockNumber} 发现子网相关事件：${text}`, payload);
        this.emit('alert');
        if (isSubnetLifecycleEvent(method)) await this.verifySubnetList();
      }
      if (/subtensor|swap/i.test(section) && /(stake|unstake|alpha|swap)/i.test(method)) {
        const data = event.data?.toHuman?.() || event.data?.toString?.();
        this.state.chainFlow.recent.push({ ts: Date.now(), blockNumber, event: text, data });
        this.state.chainFlow = this.prunedChainFlow();
        this.emit('flow');
      }
    }
  }

  prunedChainFlow() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recent = (this.state.chainFlow?.recent || []).filter((item) => item.ts >= cutoff).slice(-300);
    return {
      stakeAlphaEvents24h: recent.filter((item) => /stake|add/i.test(item.event) && !/unstake|remove/i.test(item.event)).length,
      unstakeAlphaEvents24h: recent.filter((item) => /unstake|remove/i.test(item.event)).length,
      recent
    };
  }

  async verifySubnetList() {
    const before = new Set(this.lastNetuids);
    await this.refresh('subnet list 校验');
    const after = new Set(this.lastNetuids);
    if (before.size && changed(before, after)) {
      await this.notifier.alert('定期校验发现 subnet list 发生变化', {
        before: [...before].sort((a, b) => a - b),
        after: [...after].sort((a, b) => a - b)
      });
    }
  }

  detectListDiff(next) {
    if (!this.lastNetuids.size) return;
    const added = [...next].filter((id) => !this.lastNetuids.has(id));
    const removed = [...this.lastNetuids].filter((id) => !next.has(id));
    if (added.length || removed.length) {
      this.notifier.alert('检测到 subnet 列表变化', { added, removed }).catch(() => {});
    }
  }

  recordError(error) {
    const item = { ts: Date.now(), message: error.message };
    this.state.errors.push(item);
    this.logger.warn('采集器异常', item);
  }
}

function normalizeSubnets(items, registrationCost, immunityPeriod, currentBlock, cfg) {
  const block = Number(currentBlock || 0);
  const fallback = Array.from({ length: cfg.maxSubnets || 128 }, (_, i) => ({ netuid: i + 1 }));
  const source = items.length ? items : fallback;
  return source.map((item) => {
    const netuid = Number(item.netuid ?? item.netUID ?? item.uid ?? item.id);
    const regBlock = nullableNumber(item.registrationBlock ?? item.registration_block ?? item.createdAtBlock);
    const imm = nullableNumber(item.immunityPeriod ?? item.immunity_period ?? immunityPeriod);
    const end = regBlock != null && imm != null ? regBlock + imm : null;
    const remaining = end != null ? Math.max(0, end - block) : null;
    const immunityKnown = end != null && block > 0;
    const inImmunity = immunityKnown ? remaining > 0 : false;
    const raceEligible = immunityKnown ? !inImmunity : false;
    return {
      netuid,
      name: item.name || item.subnetName || `Subnet ${netuid}`,
      alphaPrice: nullableNumber(item.alphaPrice ?? item.alpha_price ?? item.price),
      registrationCost: nullableNumber(item.registrationCost ?? item.registration_cost ?? registrationCost),
      emaPrice: nullableNumber(item.emaPrice ?? item.ema_price ?? item.moving_price),
      volume1h: nullableNumber(item.volume1h ?? item.volume_1h),
      volume24h: nullableNumber(item.volume24h ?? item.volume_24h),
      registrationBlock: regBlock,
      immunityPeriod: imm,
      immunityEndsAtBlock: end,
      remainingImmunityBlocks: remaining,
      immunityKnown,
      inImmunity,
      raceEligible,
      riskLevel: immunityKnown ? (inImmunity ? 'immune' : (item.riskLevel || 'watch')) : 'unknown'
    };
  }).filter((item) => Number.isFinite(item.netuid)).sort((a, b) => a.netuid - b.netuid);
}

function normalizeRpcSubnet(item) {
  const netuid = asNumber(firstDefined(item.netuid, item.netUID, item.uid, item.id));
  if (!Number.isFinite(netuid) || netuid === 0) return null;
  return {
    netuid,
    name: subnetName(item, netuid),
    alphaPrice: asNumber(firstDefined(item.alphaPrice, item.alpha_price, item.price, item.currentAlphaPrice)),
    emaPrice: asNumber(firstDefined(item.emaPrice, item.ema_price, item.movingPrice, item.moving_price)),
    registrationBlock: asNumber(firstDefined(item.registrationBlock, item.registration_block, item.networkRegisteredAt, item.network_registered_at)),
    immunityPeriod: asNumber(firstDefined(item.immunityPeriod, item.immunity_period)),
    rawVolume: asNumber(firstDefined(item.rawVolume, item.subnetVolume, item.subnet_volume, item.volume)),
    symbol: stringifyValue(item.symbol),
    tempo: asNumber(item.tempo),
    alphaIn: asNumber(firstDefined(item.alphaIn, item.alpha_in)),
    alphaOut: asNumber(firstDefined(item.alphaOut, item.alpha_out)),
    taoIn: asNumber(firstDefined(item.taoIn, item.tao_in))
  };
}

function isSubnetLifecycleEvent(method) {
  return /(subnet|network).*(add|added|remove|removed|deregister|prune)|^(SubnetAdded|SubnetRemoved|NetworkAdded|NetworkRemoved|SubnetPruned)$/i.test(method);
}

function subnetName(item, netuid) {
  const identity = firstDefined(item.subnetIdentity, item.subnet_identity, item.identity);
  const identityName = identity && typeof identity === 'object'
    ? firstDefined(identity.subnetName, identity.subnet_name, identity.name)
    : null;
  return stringifyValue(firstDefined(item.name, item.subnetName, item.subnet_name, identityName, item.symbol)) || `Subnet ${netuid}`;
}

function compareSubnets(a, b, sort) {
  if (sort === 'ema') return num(a.emaPrice, Infinity) - num(b.emaPrice, Infinity) || a.netuid - b.netuid;
  if (sort === 'volume1h') return num(b.volume1h, -1) - num(a.volume1h, -1) || a.netuid - b.netuid;
  if (sort === 'volume24h') return num(b.volume24h, -1) - num(a.volume24h, -1) || a.netuid - b.netuid;
  return a.netuid - b.netuid;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replaceAll(',', ''));
  return Number.isFinite(n) ? n : null;
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const n = value.startsWith('0x') ? Number.parseInt(value, 16) : Number(value.replaceAll(',', ''));
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'object') {
    if ('value' in value) return asNumber(value.value);
    if ('bits' in value) return asNumber(value.bits);
    if ('rao' in value) return asNumber(value.rao);
    if ('tao' in value) return asNumber(value.tao);
  }
  return null;
}

function firstDefined(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '');
}

function stringifyValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'object' && 'value' in value) return stringifyValue(value.value);
  return '';
}

function parseMaybeNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = value.startsWith('0x') ? Number.parseInt(value, 16) : Number(value);
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

function deltaSince(history, sinceTs) {
  if (history.length < 2) return null;
  const current = history[history.length - 1].value;
  let base = history[0].value;
  for (const point of history) {
    if (point.ts >= sinceTs) {
      base = point.value;
      break;
    }
  }
  const delta = current - base;
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
}

function num(value, fallback) {
  return value === null || value === undefined ? fallback : Number(value);
}

function changed(a, b) {
  if (a.size !== b.size) return true;
  for (const item of a) if (!b.has(item)) return true;
  return false;
}

function maskEndpoint(endpoint) {
  return endpoint.replace(/(api-bittensor-mainnet\.n\.dwellir\.com\/).+$/i, '$1******');
}
