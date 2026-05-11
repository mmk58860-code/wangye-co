# wangye-co

`wangye-co` 是一个面向 Dwellir Bittensor TAO RPC 的中文子网监控网页。

## 功能

- Dwellir API 池：多个 API Key/Endpoint、启用/禁用、单 key RPS、全局 RPS、超时、重试。
- Web 前端：左侧菜单，右侧 128 个 subnet 卡片，支持按 `1-128`、`EMA`、`1小时交易量`、`24小时交易量` 对整个卡片列表排序。
- 赛马/淘汰风险：当前 subnet 数量、128 上限、注册成本、immunity period、当前区块、下一个可淘汰候选、不在免疫期数量、EMA 低价排名、免疫期剩余时间。
- 实时监控：订阅新区块头并读取 `system.events`，发现 subnet 注册/注销/淘汰相关事件立刻日志与 TG 推送；同时按间隔拉全量 subnet list 校验。
- 日志：保留 48 小时，显示北京时间。
- Telegram：在系统设置里配置 bot token 和 chat id。
- Ubuntu 安装向导：中文询问端口、网页账号、网页密码。
- 强制 GitHub 升级：升级脚本每次从 GitHub 最新 release 或 main 分支重建同步，保留 `.env` 和 `data/`。

## Dwellir 接口

默认端点格式：

- HTTPS: `https://api-bittensor-mainnet.n.dwellir.com/<API_KEY>`
- WebSocket: `wss://api-bittensor-mainnet.n.dwellir.com/<API_KEY>`

项目使用：

- `chain_subscribeNewHeads` 订阅新区块头。
- `system.events` 读取每个新区块事件。
- `subnetInfo_getSubnetToPrune` 查询下一个可淘汰候选。
- Bittensor Python SDK `all_subnets()` 解码 subnet dynamic info。
- `subnet_volume` 会作为累计量进入本地滚动窗口，运行满 1 小时/24 小时后可计算对应窗口交易量。

“新区块 events 即时告警 + 定期全量 subnet list 校验”的做法是合适的：WebSocket 负责低延迟，定期校验负责断线、重连、事件解析漏掉时的最终一致性。

## 本地运行

```bash
npm install
python3 -m venv venv
venv/bin/python -m pip install -r requirements.txt
cp .env.example .env
npm start
```

默认账号：`admin`

默认密码：`admin123`

首次进入后请马上在“系统设置”里改密码并填写 Dwellir API。

## Ubuntu 安装

```bash
sudo bash scripts/install-ubuntu.sh
```

安装向导会中文询问端口、网页账号和网页密码。安装完成后访问：

```text
http://服务器IP:端口
```

## 强制升级

先确保 `.env` 或 `data/config.json` 里设置了：

```text
GITHUB_REPO=owner/repo
```

然后运行：

```bash
sudo bash /opt/wangye-co/scripts/upgrade.sh
```

升级脚本会从 GitHub 最新 release 拉取；如果仓库没有 release，则拉 main 分支。它会用临时目录同步最新源码并 `--delete` 清理旧源码文件，所以不会被本地旧文件干扰；`.env`、`data/`、`node_modules/`、`venv/` 会保留。
