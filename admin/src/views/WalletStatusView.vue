<script setup lang="ts">
import { computed, ref } from 'vue';

/**
 * Web3 钱包现状：钱包（arm/web/src/lib/wallet + arm/indexer）用到的第三方服务说明。静态内容，改了钱包要同步改这里。
 */

interface Link { label: string; url: string }
interface ChainRow {
  name: string; kind: 'EVM' | '非 EVM'; note: string;
  nodes: string; swap: string; chart: string; price: string; extra: string; explorer: Link;
}
interface Row { what: string; vendor: string; site: Link; how: string; cost: string; risk?: string }
interface Upgrade { item: string; now: string; problem: string; vendors: Link[]; apply: string; code: '不用改代码' | '小改动' | '要开发' | '—' }
interface EnvKey { name: string; use: string; vendor: string; payer: string }

const UPDATED = '2026-10-08';

const chains: ChainRow[] = [
  {
    name: 'Arc', kind: 'EVM', note: 'Circle 发的 L1，gas 用 USDC（chainId 5042），Arm 发射台所在链',
    nodes: '手机直连 Circle 官方公共节点 rpc.mainnet.arc.io，备用 Arcscan 的 rpc.arc-scan.org。服务器 indexer 用 RPC_URL（已配专用节点），备用 BeamRPC / Tenderly / QuickNode',
    swap: 'Arm 自研路由（池子建在 Arc 官方 Uniswap V3 工厂上，一边必须是 USDC）',
    chart: 'Arm indexer 自己索引链上成交生成 K 线，不依赖第三方',
    price: 'Arm 自己的代币表', extra: 'Arm 发币合约（自研 LaunchFactory）、$BOAT 小游戏',
    explorer: { label: 'Arcscan', url: 'https://arc-scan.org' },
  },
  {
    name: 'Ethereum', kind: 'EVM', note: '',
    nodes: '手机直连免费公共节点，4 个可切换：PublicNode（Allnodes）、LlamaRPC（LlamaNodes）、1RPC（Automata）、dRPC；用户也能自己加节点',
    swap: 'KyberSwap', chart: 'GeckoTerminal（CoinGecko）', price: '代币：DexScreener；ETH：CoinGecko', extra: 'DApp 浏览器',
    explorer: { label: 'Etherscan', url: 'https://etherscan.io' },
  },
  {
    name: 'BNB Chain', kind: 'EVM', note: '',
    nodes: '手机直连：BNB Chain 官方 bsc-dataseed、币安 bsc-dataseed1、PublicNode、1RPC',
    swap: 'KyberSwap', chart: 'GeckoTerminal（CoinGecko）', price: '代币：DexScreener；BNB：CoinGecko',
    extra: '美股：币安 bStocks 股票代币（23 只白名单），买卖走 KyberSwap',
    explorer: { label: 'BscScan', url: 'https://bscscan.com' },
  },
  {
    name: 'Base', kind: 'EVM', note: 'Coinbase 的 L2',
    nodes: '手机直连：Base 官方 mainnet.base.org（Coinbase）、PublicNode、1RPC、dRPC',
    swap: 'KyberSwap', chart: 'GeckoTerminal（CoinGecko）', price: '代币：DexScreener；ETH：CoinGecko',
    extra: 'USDC 生息（Morpho 金库）；AI 模型付款（Base 上的 USDC 付给 BlockRun）',
    explorer: { label: 'Basescan', url: 'https://basescan.org' },
  },
  {
    name: 'Arbitrum', kind: 'EVM', note: '',
    nodes: '手机直连：Arbitrum 官方 arb1.arbitrum.io（Offchain Labs）、PublicNode、1RPC、dRPC',
    swap: 'KyberSwap', chart: 'GeckoTerminal（CoinGecko）', price: '代币：DexScreener；ETH：CoinGecko',
    extra: 'Hyperliquid 合约入金：Arbitrum 上的 USDC 走 Hyperliquid 官方桥（至少 5 USDC）',
    explorer: { label: 'Arbiscan', url: 'https://arbiscan.io' },
  },
  {
    name: 'Polygon', kind: 'EVM', note: '',
    nodes: '手机直连：polygon-rpc.com、PublicNode、1RPC、dRPC',
    swap: 'KyberSwap', chart: 'GeckoTerminal（CoinGecko）', price: '代币：DexScreener；POL：CoinGecko', extra: '',
    explorer: { label: 'Polygonscan', url: 'https://polygonscan.com' },
  },
  {
    name: 'Solana', kind: '非 EVM', note: '',
    nodes: '经我们服务器中转（/api/sol/rpc；大陆连不上公共节点，付费 key 也不能放进 App）→ 上游 Solana 官方公共节点 api.mainnet-beta.solana.com + PublicNode，目前没配付费节点。备用：手机直连 PublicNode',
    swap: 'Jupiter（免费版 lite-api.jup.ag：报价 + 组交易，手机本地签名）',
    chart: 'pump.fun 币：pump.fun 自家接口；其它代币暂无 K 线',
    price: 'Jupiter（代币信息和价格，含 SOL）',
    extra: 'pump.fun 币的行情 / 成交 / 喊单来自 pump.fun 接口，买卖仍走 Jupiter；DApp 浏览器支持 Solana DApp',
    explorer: { label: 'Solscan', url: 'https://solscan.io' },
  },
  {
    name: 'TRON', kind: '非 EVM', note: '',
    nodes: '经我们服务器中转（/api/trx）→ PublicNode 的 TRON 全节点（主）+ TronGrid（TRON 官方，备用；TRC20 余额只有 TronGrid 能查），都没配 key',
    swap: '暂不支持（只能收发）', chart: '无', price: 'TRC20：DexScreener；TRX：CoinGecko', extra: '',
    explorer: { label: 'Tronscan', url: 'https://tronscan.org' },
  },
  {
    name: 'TON', kind: '非 EVM', note: '原生币 2026-06 起改名 Gram（GRAM），网络仍叫 TON',
    nodes: '经我们服务器中转（/api/ton）→ Orbs TON Access 去中心化节点（主，免费）+ toncenter（备用，没配 key）',
    swap: '暂不支持（只能收发）', chart: '无', price: 'tonapi.io（代币信息、价格、交易解析，没配 key）', extra: '',
    explorer: { label: 'Tonviewer', url: 'https://tonviewer.com' },
  },
];

const features: Row[] = [
  { what: 'EVM 兑换（ETH / BNB / Base / Arbitrum / Polygon）', vendor: 'KyberSwap（Kyber Network）', site: { label: 'kyberswap.com', url: 'https://kyberswap.com' }, how: '服务器向 Kyber 聚合器要报价、组交易，手机本地签名后广播', cost: '免费；我们不收兑换手续费', risk: '没有合同保障的额度，量大可能限流' },
  { what: 'Solana 兑换（含 pump.fun 币）', vendor: 'Jupiter', site: { label: 'jup.ag', url: 'https://jup.ag' }, how: '服务器调 Jupiter 免费版接口拿报价和交易，手机签名', cost: '免费', risk: '免费版限额低，官方已推付费 key 版' },
  { what: 'Arc 兑换', vendor: 'Arm 自研路由 + Uniswap V3 池子', site: { label: 'arm.yyheart.com', url: 'https://arm.yyheart.com' }, how: '直接调链上合约', cost: '链上 gas（USDC）', risk: '' },
  { what: '永续合约交易（含 AI 托管）', vendor: 'Hyperliquid（Hyperliquid Labs）', site: { label: 'hyperliquid.xyz', url: 'https://hyperliquid.xyz' }, how: '下单用手机生成的 agent key 签名（只能交易不能提币，180 天有效），经服务器 /api/hl 中转（服务器改不了签名内容）；入金走 Arbitrum 官方桥', cost: 'Hyperliquid 收交易费，提现 1 USDC；我们的 builder 分成（0.05%）还没开', risk: '接口按服务器 IP 限流' },
  { what: '合约喊单 / 合约雷达 / 大户榜', vendor: 'Hyperliquid', site: { label: 'hyperliquid.xyz', url: 'https://hyperliquid.xyz' }, how: 'info 接口查仓位、K 线；stats-data 排行榜', cost: '免费', risk: '' },
  { what: 'USDC 生息（Base）', vendor: 'Morpho；金库管理方 Gauntlet / Spark / Steakhouse Financial', site: { label: 'morpho.org', url: 'https://morpho.org' }, how: '钱包直接调 3 个白名单金库合约（ERC-4626）存取；年化、规模来自 Morpho GraphQL 接口', cost: '免费；金库收自己的管理费', risk: '合约风险、收益浮动，页面已提示' },
  { what: '美股（BNB Chain）', vendor: '币安 bStocks（股票代币）', site: { label: 'binance.com', url: 'https://www.binance.com' }, how: '23 只白名单代币，买卖走 KyberSwap，价格 / K 线同 EVM 代币', cost: '兑换免费', risk: '凭证不是股权、不向美国用户提供，页面已提示' },
  { what: 'EVM 热门榜、K 线、成交', vendor: 'GeckoTerminal（CoinGecko 旗下）', site: { label: 'geckoterminal.com', url: 'https://www.geckoterminal.com' }, how: '服务器调公开接口，全部缓存、排队', cost: '免费（没配 CoinGecko key）', risk: '公开接口实测突发 4 次后约 11 秒 1 次，用户多了 K 线会排队' },
  { what: '代币详情、搜索、价格（EVM / TRON）', vendor: 'DexScreener', site: { label: 'dexscreener.com', url: 'https://dexscreener.com' }, how: '服务器调接口并缓存', cost: '免费（约 300 次/分钟，不要 key）', risk: '' },
  { what: '主币价格（ETH / BNB / SOL / TRX…）', vendor: 'CoinGecko', site: { label: 'coingecko.com', url: 'https://www.coingecko.com' }, how: '手机直连 simple/price 公开接口', cost: '免费', risk: '' },
  { what: 'pump.fun 币行情 / K 线 / 喊单', vendor: 'pump.fun', site: { label: 'pump.fun', url: 'https://pump.fun' }, how: '服务器调 pump.fun 网页用的接口；读喊单要用一个空钱包登录（PUMP_AUTH_KEY，不放钱）', cost: '免费', risk: '非公开接口，pump 改了就会停' },
  { what: '代币图标', vendor: 'Trust Wallet Assets（GitHub 开源图标库）+ 各数据源图片', site: { label: 'github.com/trustwallet/assets', url: 'https://github.com/trustwallet/assets' }, how: '经服务器图片中转（大陆打不开的图床）', cost: '免费', risk: '' },
  { what: 'AI 模型（聊天 / 生图 / 视频 / 语音 / 音乐 / 音效）', vendor: 'BlockRun', site: { label: 'blockrun.ai', url: 'https://blockrun.ai' }, how: 'x402 协议：用户用 Base 上的 USDC 按条付费（本机签名，不花 gas），服务器只中转；签名前校验收款地址', cost: '用户付，我们不垫钱', risk: 'BlockRun 换收款地址要更新前端常量' },
  { what: 'DApp 浏览器推荐', vendor: 'Uniswap、PancakeSwap、Aerodrome、1inch、CoW Swap、QuickSwap、Jumper（LI.FI）、Across、Stargate、Aave、Lido、Venus、Morpho、OpenSea、Magic Eden、Revoke.cash、DeBank', site: { label: '各自官网', url: 'https://app.uniswap.org' }, how: '只是在钱包里打开对方网站，用户自己连接、签名；我们不调它们的接口', cost: '免费', risk: '' },
  { what: '区块浏览器链接', vendor: 'Etherscan（BscScan / Basescan / Arbiscan / Polygonscan 同一家）、Solscan、Tronscan、Tonviewer、Arcscan', site: { label: 'etherscan.io', url: 'https://etherscan.io' }, how: '只做跳转', cost: '免费', risk: '' },
];

const ai: Row[] = [
  { what: '钱包「AI 模型」', vendor: 'BlockRun（转售 OpenAI、Anthropic、Google、DeepSeek、xAI、ElevenLabs、MiniMax 等 80 多个模型）', site: { label: 'blockrun.ai', url: 'https://blockrun.ai' }, how: '用户 USDC 按条付费，不用注册、不用 key', cost: '用户付' },
  { what: '钱包「AI 合约」分析 + AI 托管', vendor: 'DeepSeek（深度求索）', site: { label: 'platform.deepseek.com', url: 'https://platform.deepseek.com' }, how: '用户填自己的 key（默认推荐）', cost: '用户自己的账户付' },
  { what: '〃', vendor: '硅基流动 SiliconFlow', site: { label: 'cloud.siliconflow.cn', url: 'https://cloud.siliconflow.cn' }, how: '用户自己的 key', cost: '用户付' },
  { what: '〃', vendor: '阿里云百炼（通义千问）', site: { label: 'bailian.console.aliyun.com', url: 'https://bailian.console.aliyun.com' }, how: '用户自己的 key', cost: '用户付' },
  { what: '〃', vendor: '月之暗面 Kimi', site: { label: 'platform.moonshot.cn', url: 'https://platform.moonshot.cn' }, how: '用户自己的 key', cost: '用户付' },
  { what: '〃', vendor: '智谱 GLM', site: { label: 'open.bigmodel.cn', url: 'https://open.bigmodel.cn' }, how: '用户自己的 key', cost: '用户付' },
  { what: '〃', vendor: 'OpenRouter', site: { label: 'openrouter.ai', url: 'https://openrouter.ai' }, how: '用户自己的 key', cost: '用户付' },
  { what: '〃', vendor: 'OpenAI', site: { label: 'platform.openai.com', url: 'https://platform.openai.com' }, how: '用户自己的 key；也能填任意 OpenAI 兼容地址', cost: '用户付' },
  { what: 'Arm 网站热点资讯 / 文案（不是钱包）', vendor: 'DeepSeek、OpenRouter（gpt-4o-mini）', site: { label: 'openrouter.ai', url: 'https://openrouter.ai' }, how: '服务器的 key', cost: '我们付（预充值）' },
  { what: 'Arm 网站资讯配图（不是钱包）', vendor: 'fal.ai（Flux 生图）', site: { label: 'fal.ai', url: 'https://fal.ai' }, how: '服务器的 key', cost: '我们付' },
  { what: 'AI 实盘对战（工具页）', vendor: 'NOFX（开源，自己部署）+ DeepSeek', site: { label: 'github.com/NoFxAiOS/nofx', url: 'https://github.com/NoFxAiOS/nofx' }, how: '交易在 Hyperliquid，团队自有资金，用户只看', cost: '我们付' },
];

const upgrades: Upgrade[] = [
  {
    item: 'EVM 节点（ETH / BNB / Base / Arbitrum / Polygon）', now: '手机直连免费公共节点，每条链 4 个可切换，用户也能自己加',
    problem: '公共节点会限流、偶发超时；不过是按每个用户的 IP 算，用户多了不会一起撞上限',
    vendors: [{ label: 'Alchemy', url: 'https://www.alchemy.com' }, { label: 'QuickNode', url: 'https://www.quicknode.com' }, { label: 'Infura', url: 'https://www.infura.io' }, { label: 'dRPC', url: 'https://drpc.org' }, { label: 'NodeReal（BNB 链）', url: 'https://nodereal.io' }],
    apply: '注册拿到每条链的节点地址。付费 key 不能直接写进 App（会被扒走）：要么照 Solana 的做法在 indexer 加 /api/evm/<链> 中转、key 放 indexer.env；要么用服务商的「来源域名白名单」把 key 锁在 arm.yyheart.com 再放进内置列表',
    code: '要开发',
  },
  {
    item: 'Solana 节点', now: '经服务器中转，上游 Solana 官方公共节点 + PublicNode，没配付费节点',
    problem: '所有用户的请求都从服务器一个 IP 出去，最先撞上限流；部分代币余额查询公共节点不支持',
    vendors: [{ label: 'Helius', url: 'https://www.helius.dev' }, { label: 'QuickNode', url: 'https://www.quicknode.com' }, { label: 'Triton', url: 'https://triton.one' }],
    apply: '注册拿节点地址 → 写进 Arm 服务器 /opt/arm/indexer.env：SOL_RPC_URLS=地址1,地址2（按顺序重试）→ 重启 indexer',
    code: '不用改代码',
  },
  {
    item: 'TRON 节点', now: '经服务器中转，PublicNode 主 + TronGrid 备，都没 key',
    problem: 'TronGrid 没 key 时每个服务器 IP 约 3 次/秒，超了会被暂停几秒；TRC20 余额只有 TronGrid 能查',
    vendors: [{ label: 'TronGrid（免费注册拿 key）', url: 'https://www.trongrid.io' }, { label: 'QuickNode', url: 'https://www.quicknode.com' }, { label: 'GetBlock', url: 'https://getblock.io' }],
    apply: 'TronGrid 注册拿 API key → indexer.env 设 TRON_API_KEY；换付费全节点就设 TRON_API=地址',
    code: '不用改代码',
  },
  {
    item: 'TON 节点', now: '经服务器中转，Orbs TON Access 主（免费）+ toncenter 备（没 key）',
    problem: 'toncenter 没 key 约 1 次/秒；Orbs 免费但不保证可用',
    vendors: [{ label: 'toncenter（Telegram 找 @tonapibot 申请 key）', url: 'https://toncenter.com' }, { label: 'Chainstack', url: 'https://chainstack.com' }],
    apply: 'indexer.env 设 TON_API_KEY（toncenter key）；固定节点设 TON_API=地址（可多个，逗号分隔）',
    code: '不用改代码',
  },
  {
    item: 'TON 代币信息 / 价格（tonapi）', now: '没 key，约 1 次/秒，服务器排队',
    problem: 'TON 用户和代币多了会排队变慢',
    vendors: [{ label: 'TON Console（tonapi key）', url: 'https://tonconsole.com' }],
    apply: '申请 tonapi key；代码里要加一个请求头',
    code: '小改动',
  },
  {
    item: 'EVM K 线 / 热门榜（GeckoTerminal）', now: '公开接口，没 key，服务器缓存 + 排队',
    problem: '同时看代币页的人多了，K 线排队或显示旧数据',
    vendors: [{ label: 'CoinGecko API（Demo 免费 key / 付费档）', url: 'https://www.coingecko.com/en/api/pricing' }],
    apply: 'indexer.env 设 CG_API_KEY；付费档再加 CG_PLAN=pro；CG_DAILY 控制每天最多用多少次',
    code: '不用改代码',
  },
  {
    item: '代币详情 / 价格（DexScreener）', now: '没 key，约 300 次/分钟，有缓存',
    problem: '一般够用；它没有公开的付费档',
    vendors: [{ label: 'Birdeye', url: 'https://birdeye.so' }, { label: 'Codex', url: 'https://www.codex.io' }],
    apply: '不够时换付费数据源',
    code: '要开发',
  },
  {
    item: 'EVM 兑换（KyberSwap）', now: '免费，clientId = arm-wallet',
    problem: '量大可能限流',
    vendors: [{ label: 'KyberSwap 商务合作', url: 'https://kyberswap.com' }],
    apply: '联系 Kyber 申请专属 clientId / 额度 → indexer.env 设 KYBER_CLIENT_ID；以后想收平台手续费也找他们开分成',
    code: '不用改代码',
  },
  {
    item: 'Solana 兑换（Jupiter）', now: '免费版 lite-api.jup.ag',
    problem: '免费版限额低，官方可能下线免费版',
    vendors: [{ label: 'Jupiter Portal（申请 API key）', url: 'https://portal.jup.ag' }],
    apply: '申请 key → indexer.env 设 JUP_BASE=https://api.jup.ag；代码里要加 x-api-key 请求头',
    code: '小改动',
  },
  {
    item: 'Hyperliquid 合约', now: '官方公开接口，经服务器中转（按服务器 IP 计权重，官方每 IP 每分钟 1200 权重）',
    problem: '合约用户多了，读接口先被限流（下单量一般不大）',
    vendors: [{ label: 'Hyperliquid 官方文档', url: 'https://hyperliquid.gitbook.io/hyperliquid-docs' }, { label: 'QuickNode（Hyperliquid 节点）', url: 'https://www.quicknode.com' }],
    apply: '先加大缓存；再不够就自己跑 Hyperliquid 非验证节点，或用第三方 Hyperliquid 节点',
    code: '要开发',
  },
  {
    item: 'Arc 节点', now: '手机直连 Circle 官方公共节点；服务器已配专用 RPC_URL + 3 个备用',
    problem: '—',
    vendors: [{ label: 'QuickNode', url: 'https://www.quicknode.com' }, { label: 'Tenderly', url: 'https://tenderly.co' }],
    apply: 'indexer.env 的 RPC_URL / RPC_URLS',
    code: '不用改代码',
  },
  {
    item: 'pump.fun 数据', now: '非公开接口，没有付费档',
    problem: 'pump 改接口功能就停',
    vendors: [{ label: 'Birdeye', url: 'https://birdeye.so' }, { label: 'Moralis', url: 'https://moralis.com' }],
    apply: '出问题时换成这些付费 Solana 数据源',
    code: '要开发',
  },
  {
    item: 'BlockRun / Morpho / CoinGecko 主币价格', now: '用户付费 / 免费 / 手机直连',
    problem: '不用管', vendors: [], apply: '—', code: '—',
  },
];

const envKeys: EnvKey[] = [
  { name: 'RPC_URL / RPC_URLS / DEX_BACKFILL_RPCS', use: 'Arc 节点（indexer 读链）', vendor: '专用 Arc 节点 + BeamRPC / Tenderly / QuickNode', payer: '按节点服务商' },
  { name: 'DEEPSEEK_API_KEY', use: 'Arm 网站热点资讯、AI 实盘对战', vendor: 'DeepSeek', payer: '我们' },
  { name: 'OPENROUTER_API_KEY', use: 'Arm 网站热点资讯文案', vendor: 'OpenRouter', payer: '我们' },
  { name: 'FAL_KEY', use: 'Arm 网站资讯配图', vendor: 'fal.ai', payer: '我们' },
  { name: 'X_BEARER_TOKEN', use: 'Arm 网站热点抓 X 帖子', vendor: 'X API（按量付费）', payer: '我们' },
  { name: 'PUMP_AUTH_KEY', use: '登录 pump.fun 读喊单（空钱包，不放钱）', vendor: 'pump.fun', payer: '免费' },
  { name: 'AI_BOT_SECRET', use: '加密保存用户 AI 托管填的模型 key', vendor: '自己生成', payer: '—' },
  { name: '未配置：SOL_RPC_URLS、TRON_API_KEY、TON_API_KEY、CG_API_KEY、KYBER_CLIENT_ID、HL_BUILDER', use: '见上面「用户量上来后怎么升级」', vendor: '—', payer: '—' },
];

const chainTab = ref<'all' | 'EVM' | '非 EVM'>('all');
const shownChains = computed(() => chains.filter((c) => chainTab.value === 'all' || c.kind === chainTab.value));
const evmCount = chains.filter((c) => c.kind === 'EVM').length;
const codeTag = (c: Upgrade['code']) => (c === '不用改代码' ? 'ok' : c === '小改动' ? 'warn' : c === '要开发' ? 'off' : '');
</script>

<template>
  <div class="ws">
    <div class="page-title">Web3 钱包现状（第三方服务）</div>

    <div class="card">
      <div class="ws-sum">
        <div><b>{{ chains.length }} 条链</b><span>EVM {{ evmCount }} · 非 EVM {{ chains.length - evmCount }}</span></div>
        <div><b>自托管</b><span>私钥只在用户手机上，服务器碰不到钱</span></div>
        <div><b>0 手续费</b><span>兑换、合约我们都还没收平台费</span></div>
        <div><b>服务器中转</b><span>Arm indexer（arm.yyheart.com/api）</span></div>
      </div>
      <p class="muted" style="margin-top: 12px">
        钱包页面在 Arm 网站（arm.yyheart.com/wallet），心之音 App 里用壳打开；行情、兑换报价、Solana / TRON / TON 节点、合约、AI 都经 Arm 服务器上的 indexer 中转，交易都在手机上签名。
        目前除了 Arc 节点和 Arm 网站资讯用的 AI，钱包用的第三方全是免费额度。内容整理于 {{ UPDATED }}，依据代码 <code>arm/web/src/lib/wallet</code>、<code>arm/indexer/src</code>；价格和额度以各家官网为准。
      </p>
    </div>

    <div class="card">
      <div class="row" style="margin-bottom: 12px; flex-wrap: wrap">
        <div style="font-weight: 600">一、每条链用了什么</div>
        <div class="cat-tabs" style="margin: 0">
          <button :class="{ ghost: chainTab !== 'all' }" @click="chainTab = 'all'">全部<span class="n">{{ chains.length }}</span></button>
          <button :class="{ ghost: chainTab !== 'EVM' }" data-testid="ws-evm" @click="chainTab = 'EVM'">EVM<span class="n">{{ evmCount }}</span></button>
          <button :class="{ ghost: chainTab !== '非 EVM' }" data-testid="ws-nonevm" @click="chainTab = '非 EVM'">非 EVM<span class="n">{{ chains.length - evmCount }}</span></button>
        </div>
      </div>
      <table>
        <thead><tr><th style="min-width: 110px">链</th><th style="min-width: 260px">节点</th><th>兑换</th><th>K 线 / 行情</th><th>价格</th><th>其它</th><th>浏览器</th></tr></thead>
        <tbody>
          <tr v-for="c in shownChains" :key="c.name" :data-testid="`ws-chain-${c.name}`">
            <td>
              <div style="font-weight: 600">{{ c.name }}</div>
              <span class="tag" :class="c.kind === 'EVM' ? 'ok' : 'warn'">{{ c.kind }}</span>
              <div v-if="c.note" class="muted" style="font-size: 12px; margin-top: 4px">{{ c.note }}</div>
            </td>
            <td class="ws-txt">{{ c.nodes }}</td>
            <td class="ws-txt">{{ c.swap }}</td>
            <td class="ws-txt">{{ c.chart }}</td>
            <td class="ws-txt">{{ c.price }}</td>
            <td class="ws-txt">{{ c.extra || '—' }}</td>
            <td><a :href="c.explorer.url" target="_blank" rel="noopener">{{ c.explorer.label }}</a></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div style="font-weight: 600; margin-bottom: 12px">二、功能对应的第三方</div>
      <table>
        <thead><tr><th>功能</th><th>第三方（公司）</th><th>官网</th><th style="min-width: 240px">怎么接的</th><th>费用</th><th>风险 / 限制</th></tr></thead>
        <tbody>
          <tr v-for="r in features" :key="r.what">
            <td style="font-weight: 600">{{ r.what }}</td>
            <td class="ws-txt">{{ r.vendor }}</td>
            <td><a :href="r.site.url" target="_blank" rel="noopener">{{ r.site.label }}</a></td>
            <td class="ws-txt">{{ r.how }}</td>
            <td class="ws-txt">{{ r.cost }}</td>
            <td class="ws-txt muted">{{ r.risk || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div style="font-weight: 600; margin-bottom: 12px">三、AI 对接了哪些公司</div>
      <table>
        <thead><tr><th>用在哪</th><th>公司</th><th>官网</th><th>怎么接</th><th>谁付钱</th></tr></thead>
        <tbody>
          <tr v-for="(r, i) in ai" :key="i">
            <td style="font-weight: 600">{{ r.what }}</td>
            <td class="ws-txt">{{ r.vendor }}</td>
            <td><a :href="r.site.url" target="_blank" rel="noopener">{{ r.site.label }}</a></td>
            <td class="ws-txt">{{ r.how }}</td>
            <td class="ws-txt">{{ r.cost }}</td>
          </tr>
        </tbody>
      </table>
      <p class="muted" style="margin-top: 10px">用户自己的模型 key：手动分析时只转发不保存；开 AI 托管时加密存在 Arm 服务器（AI_BOT_SECRET），只在调用时解密，不写日志。</p>
    </div>

    <div class="card">
      <div style="font-weight: 600; margin-bottom: 4px">四、用户量上来后怎么升级</div>
      <p class="muted" style="margin-bottom: 12px">按建议顺序：Solana 节点、TRON key、K 线 key 最先会撞上限，而且只要改服务器配置。配置文件都在 Arm 服务器 <code>/opt/arm/indexer.env</code>，改完重启 indexer。</p>
      <table>
        <thead><tr><th>服务</th><th>现在</th><th>会遇到什么</th><th>推荐服务商（申请地址）</th><th style="min-width: 260px">怎么接</th><th>改代码</th></tr></thead>
        <tbody>
          <tr v-for="u in upgrades" :key="u.item">
            <td style="font-weight: 600">{{ u.item }}</td>
            <td class="ws-txt">{{ u.now }}</td>
            <td class="ws-txt">{{ u.problem }}</td>
            <td class="ws-txt">
              <template v-if="u.vendors.length">
                <div v-for="v in u.vendors" :key="v.url"><a :href="v.url" target="_blank" rel="noopener">{{ v.label }}</a></div>
              </template>
              <span v-else>—</span>
            </td>
            <td class="ws-txt">{{ u.apply }}</td>
            <td><span class="tag" :class="codeTag(u.code)" style="white-space: nowrap">{{ u.code }}</span></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <div style="font-weight: 600; margin-bottom: 4px">五、服务器上已配置的第三方 key</div>
      <p class="muted" style="margin-bottom: 12px">只列名称和用途，值只在服务器上，不进仓库、不在这里显示。</p>
      <table>
        <thead><tr><th>配置项</th><th>用途</th><th>第三方</th><th>谁付钱</th></tr></thead>
        <tbody>
          <tr v-for="k in envKeys" :key="k.name">
            <td><code>{{ k.name }}</code></td>
            <td class="ws-txt">{{ k.use }}</td>
            <td class="ws-txt">{{ k.vendor }}</td>
            <td class="ws-txt">{{ k.payer }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.ws-sum { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.ws-sum div { background: var(--bg-input); border-radius: 10px; padding: 12px 14px; }
.ws-sum b { display: block; font-size: 17px; }
.ws-sum span { display: block; color: var(--text-2); font-size: 12.5px; margin-top: 4px; line-height: 1.5; }
.ws-txt { font-size: 13px; line-height: 1.6; color: var(--text); }
.ws td { vertical-align: top; }
.ws a { color: #ff8aa0; }
.ws code { font-size: 12px; background: var(--bg-input); padding: 1px 6px; border-radius: 4px; word-break: break-all; }
@media (max-width: 768px) {
  .ws-sum { grid-template-columns: 1fr 1fr; }
}
</style>
