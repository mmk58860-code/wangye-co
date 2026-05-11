import { ApiPromise, WsProvider } from '@polkadot/api';
import { PythonCollector } from './pythonCollector.js';
import { blocksToDuration } from './time.js';
import { loadState, saveState } from './storage.js';

const STATE_VERSION = 3;
const MAX_FLOW_TAO_PER_EVENT = 100000;

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
    stakeTaoToday: 0,
    unstakeTaoToday: 0,
    stakeEventsToday: 0,
    unstakeEventsToday: 0,
    bjDate: beijingDateKey(Date.now()),
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
    this.restoreState();
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
    this.schedule();
    this.connectWs().catch((error) => this.logger.warn('新区块订阅启动失败', { error: error.message }));
    this.refresh('启动采集').catch((error) => this.recordError(error));
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
      this.persistState();
      this.emit('refresh');
    } catch (error) {
      this.recordError(error);
      this.state.status = 'degraded';
      this.emit('error');
    }
    return this.snapshot();
  }

  async collect() {
    const data = await this.python.collect();
    const prune = await this.pool.rpc('subnetInfo_getSubnetToPrune').catch(() => null);
    if (data.nextPruneCandidate == null && prune != null) data.nextPruneCandidate = parseMaybeNumber(prune);
    return data;
  }

  applyCollected(data) {
    if (!Array.isArray(data.subnets) || !data.subnets.length) {
      throw new Error('采集结果为空，保留上次快照');
    }
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
        const translated = translateSubtensorEvent(method, text);
        const payload = {
          blockNumber,
          event: text,
          eventLabel: translated.label,
          data: event.data?.toHuman?.() || event.data?.toString?.()
        };
        if (translated.lifecycle) {
          this.state.lastAlert = payload;
          this.persistState();
          await this.notifier.alert(`区块 ${blockNumber}：${translated.label}`, payload);
          this.emit('alert');
          await this.verifySubnetList();
        } else {
          this.logger.info(`区块 ${blockNumber}：${translated.label}`, payload);
        }
      }
      if (/^subtensor(Module)?$/i.test(section) && /^(StakeAdded|StakeRemoved|StakeSwapped)$/i.test(method)) {
        const human = event.data?.toHuman?.() || event.data?.toString?.();
        const raw = event.data?.toJSON?.() || human;
        const flow = flowFromStakeEvent(method, raw);
        if (flow) {
          this.state.chainFlow.recent.push({
            ts: Date.now(),
            bjDate: beijingDateKey(Date.now()),
            blockNumber,
            event: text,
            eventLabel: flow.flowType === 'stake' ? '买入/质押' : '卖出/解质押',
            flowType: flow.flowType,
            amountTao: flow.amountTao,
            netuid: flow.netuid,
            data: human
          });
          this.state.chainFlow = this.prunedChainFlow();
          this.persistState();
          this.emit('flow');
        }
      }
    }
  }

  restoreState() {
    const saved = loadState();
    if (!saved?.state) return;
    this.state = {
      ...structuredClone(ZERO_STATE),
      ...saved.state,
      chainFlow: this.prunedChainFlowFrom(saved.state.chainFlow),
      errors: []
    };
    this.lastNetuids = new Set((this.state.subnets || []).map((s) => Number(s.netuid)).filter(Number.isFinite));
    this.volumeHistory = new Map(Object.entries(saved.volumeHistory || {}).map(([key, value]) => [Number(key), value]));
  }

  persistState() {
    const previous = loadState();
    const currentHasRealData = hasRealSubnetData(this.state.subnets);
    const previousHasRealData = hasRealSubnetData(previous?.state?.subnets);
    const state = currentHasRealData || !previousHasRealData
      ? this.state
      : {
          ...previous.state,
          status: this.state.status,
          currentBlock: this.state.currentBlock || previous.state.currentBlock,
          updatedAt: this.state.updatedAt || previous.state.updatedAt,
          chainFlow: this.state.chainFlow,
          lastAlert: this.state.lastAlert || previous.state.lastAlert,
          errors: []
        };
    saveState({
      version: STATE_VERSION,
      savedAt: new Date().toISOString(),
      state: {
        ...state,
        errors: []
      },
      volumeHistory: currentHasRealData
        ? Object.fromEntries(this.volumeHistory)
        : (previous?.volumeHistory || Object.fromEntries(this.volumeHistory))
    });
  }

  prunedChainFlow() {
    return this.prunedChainFlowFrom(this.state.chainFlow);
  }

  prunedChainFlowFrom(chainFlow) {
    const today = beijingDateKey(Date.now());
    const cutoff = Date.now() - 48 * 60 * 60 * 1000;
    const recent = (chainFlow?.recent || [])
      .filter((item) => item.ts >= cutoff)
      .map(normalizeFlowItem)
      .filter(Boolean)
      .slice(-500);
    const todayItems = recent.filter((item) => item.bjDate === today);
    const stakeItems = todayItems.filter((item) => item.flowType === 'stake');
    const unstakeItems = todayItems.filter((item) => item.flowType === 'unstake');
    const stakeKnown = stakeItems.filter((item) => Number.isFinite(item.amountTao)).length;
    const unstakeKnown = unstakeItems.filter((item) => Number.isFinite(item.amountTao)).length;
    return {
      stakeTaoToday: sumAmounts(stakeItems),
      unstakeTaoToday: sumAmounts(unstakeItems),
      stakeEventsToday: stakeItems.length,
      unstakeEventsToday: unstakeItems.length,
      stakeAmountEventsToday: stakeKnown,
      unstakeAmountEventsToday: unstakeKnown,
      amountReliable: stakeKnown === stakeItems.length && unstakeKnown === unstakeItems.length,
      bjDate: today,
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
      marketCap: nullableNumber(item.marketCap ?? item.market_cap ?? item.marketCapTao ?? item.market_cap_tao)
        ?? computeMarketCap(item),
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

function computeMarketCap(item) {
  const price = nullableNumber(item.alphaPrice ?? item.alpha_price ?? item.price);
  const alphaIn = nullableNumber(item.alphaIn ?? item.alpha_in);
  const alphaOut = nullableNumber(item.alphaOut ?? item.alpha_out);
  const supply = (alphaIn != null ? alphaIn : 0) + (alphaOut != null ? alphaOut : 0);
  if (!Number.isFinite(price) || !Number.isFinite(supply) || supply <= 0) return null;
  return price * supply;
}

function hasRealSubnetData(subnets) {
  return Array.isArray(subnets) && subnets.some((item) => {
    if (!item || !Number.isFinite(Number(item.netuid))) return false;
    if (item.alphaPrice != null || item.marketCap != null || item.emaPrice != null || item.volume1h != null || item.volume24h != null) return true;
    return typeof item.name === 'string' && !/^Subnet \d+$/i.test(item.name);
  });
}

function isSubnetLifecycleEvent(method) {
  return /(subnet|network).*(add|added|remove|removed|deregister|prune)|^(SubnetAdded|SubnetRemoved|NetworkAdded|NetworkRemoved|SubnetPruned)$/i.test(method);
}

function translateSubtensorEvent(method, fallback) {
  const name = String(method || '');
  if (/NeuronRegistered/i.test(name)) return { label: '子网节点注册', lifecycle: false };
  if (/NeuronDeregistered|NeuronRemoved/i.test(name)) return { label: '子网节点注销', lifecycle: false };
  if (/SubnetAdded|NetworkAdded/i.test(name)) return { label: '新子网创建', lifecycle: true };
  if (/SubnetRemoved|NetworkRemoved/i.test(name)) return { label: '子网移除', lifecycle: true };
  if (/SubnetPruned|NetworkPruned|Pruned/i.test(name)) return { label: '子网被淘汰', lifecycle: true };
  if (isSubnetLifecycleEvent(name)) return { label: '子网生命周期变更', lifecycle: true };
  return { label: fallback, lifecycle: false };
}

function flowFromStakeEvent(method, data) {
  const name = String(method || '');
  if (/^StakeAdded$/i.test(name)) {
    const netuid = eventNumber(data, 4, 'netuid');
    if (isRootNetuid(netuid)) return null;
    return buildFlow('stake', eventTao(data, 2, 'tao_amount'), netuid);
  }
  if (/^StakeRemoved$/i.test(name)) {
    const netuid = eventNumber(data, 4, 'netuid');
    if (isRootNetuid(netuid)) return null;
    return buildFlow('unstake', eventTao(data, 2, 'tao_amount'), netuid);
  }
  if (/^StakeSwapped$/i.test(name)) {
    const origin = eventNumber(data, 2, 'origin_netuid');
    const destination = eventNumber(data, 3, 'destination_netuid');
    const amountTao = eventTao(data, 4, 'tao_amount');
    if (isRootNetuid(origin) && !isRootNetuid(destination)) {
      return buildFlow('stake', amountTao, destination);
    }
    if (!isRootNetuid(origin) && isRootNetuid(destination)) {
      return buildFlow('unstake', amountTao, origin);
    }
  }
  return null;
}

function buildFlow(flowType, amountTao, netuid) {
  if (!Number.isFinite(amountTao) || amountTao <= 0 || amountTao > MAX_FLOW_TAO_PER_EVENT) return null;
  if (!Number.isFinite(Number(netuid)) || isRootNetuid(netuid)) return null;
  return { flowType, amountTao, netuid: Number(netuid) };
}

function normalizeFlowItem(item) {
  if (!item || !['stake', 'unstake'].includes(item.flowType)) return null;
  const amountTao = Number(item.amountTao);
  const netuid = Number(item.netuid);
  if (!Number.isFinite(amountTao) || amountTao <= 0 || amountTao > MAX_FLOW_TAO_PER_EVENT) return null;
  if (!Number.isFinite(netuid) || isRootNetuid(netuid)) return null;
  return { ...item, amountTao, netuid };
}

function eventTao(data, index, key) {
  const raw = eventValue(data, index, key);
  const n = parseNumeric(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e6 ? n / 1e9 : n;
}

function eventNumber(data, index, key) {
  const n = parseNumeric(eventValue(data, index, key));
  return Number.isFinite(n) ? n : null;
}

function eventValue(data, index, key) {
  if (Array.isArray(data)) return data[index];
  if (data && typeof data === 'object') {
    if (data[key] !== undefined) return data[key];
    const snake = key.replace(/[A-Z]/g, (ch) => `_${ch.toLowerCase()}`);
    if (data[snake] !== undefined) return data[snake];
    return Object.values(data)[index];
  }
  return null;
}

function parseNumeric(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'object' && 'value' in value) return parseNumeric(value.value);
  const text = String(value).replaceAll(',', '');
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function isRootNetuid(netuid) {
  return Number(netuid) === 0;
}

function sumAmounts(items) {
  return items.reduce((total, item) => total + (Number.isFinite(item.amountTao) ? item.amountTao : 0), 0);
}

function beijingDateKey(ts) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date(ts));
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
