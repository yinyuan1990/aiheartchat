import type { Address } from "viem";
import { walletLang } from "./i18n";

/**
 * 美股: Binance bStocks on BNB Chain, traded through the same KyberSwap market page as any BSC token.
 * Whitelist only — search on BSC is full of look-alikes (vanity …7777 / …ffff launchpad tokens, 8-decimal copies
 * named "… Tokenized bStocks"). Every entry is a beacon proxy with the same bytecode and beacon
 * (0x156D6dce9a4f6139a3406F1f021F1A4880De93a3) as NVDAB, which BscScan labels "bStocks: NVDAB Token".
 * Re-verify against that beacon before adding one; skip any without a pool deep enough to trade.
 */
export type Stock = { symbol: string; ticker: string; name: string; zh: string; address: Address; etf?: boolean };

export const STOCKS: Stock[] = [
  { symbol: "NVDAB", ticker: "NVDA", name: "NVIDIA", zh: "英伟达", address: "0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436" },
  { symbol: "TSLAB", ticker: "TSLA", name: "Tesla", zh: "特斯拉", address: "0x5b1910eAaD6450E50f816082Aa078C41F10C292f" },
  { symbol: "AAPLB", ticker: "AAPL", name: "Apple", zh: "苹果", address: "0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A" },
  { symbol: "GOOGLB", ticker: "GOOGL", name: "Alphabet", zh: "谷歌", address: "0x3F53De71c126BdaBAe20f9cD64848d317f6C3238" },
  { symbol: "MSFTB", ticker: "MSFT", name: "Microsoft", zh: "微软", address: "0x80106cb3EAD06659A5ad19DF39D9b4733863B9b0" },
  { symbol: "AMZNB", ticker: "AMZN", name: "Amazon", zh: "亚马逊", address: "0x1a4b499833A79A09ad7Cf1D42D7DacF71e92eb00" },
  { symbol: "METAB", ticker: "META", name: "Meta Platforms", zh: "Meta", address: "0x7425889FE94F9d693E8daefE88BCCed6AcFEf4c0" },
  { symbol: "SPCXB", ticker: "SPCX", name: "SpaceX", zh: "SpaceX", address: "0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1" },
  { symbol: "CRCLB", ticker: "CRCL", name: "Circle", zh: "Circle", address: "0x80f3D493EBCe97e343c53D29a137942416B4ffC0" },
  { symbol: "BABAB", ticker: "BABA", name: "Alibaba", zh: "阿里巴巴", address: "0x4eF9d3062c7F6ebA4AAE4990c5036598C6eff4ec" },
  { symbol: "TSMB", ticker: "TSM", name: "TSMC", zh: "台积电", address: "0xAB78b89B5bb00236Be0B4B20704cBfa04EfC711c" },
  { symbol: "MSTRB", ticker: "MSTR", name: "Strategy", zh: "Strategy", address: "0xE87afb3076AeB0f9B14E368DE8145ae6a2826A14" },
  { symbol: "COINB", ticker: "COIN", name: "Coinbase", zh: "Coinbase", address: "0x585BDE7C54ABB5cCD7791F923D6c2187635f3952" },
  { symbol: "HOODB", ticker: "HOOD", name: "Robinhood", zh: "Robinhood", address: "0xA394dCEa3fd3847fD793afBFd163E2e3858B7c65" },
  { symbol: "NFLXB", ticker: "NFLX", name: "Netflix", zh: "奈飞", address: "0xD6829Ea836b6FA224d099D40E54B31262f874631" },
  { symbol: "INTCB", ticker: "INTC", name: "Intel", zh: "英特尔", address: "0xe614E2fc6C787035FF51f452e8E826Bfd32D5283" },
  { symbol: "MUB", ticker: "MU", name: "Micron", zh: "美光", address: "0xcdf2f3e0fa43C47A6662a91C9E4a7C5f69762699" },
  { symbol: "SNDKB", ticker: "SNDK", name: "Sandisk", zh: "闪迪", address: "0x3eE4dF61bd4F867E349BEaE8bFE07bc31b4850fb" },
  { symbol: "JPMB", ticker: "JPM", name: "JPMorgan Chase", zh: "摩根大通", address: "0xbd49D695ba2cc46c8C603eb62aFcd7Fff4698281" },
  { symbol: "LLYB", ticker: "LLY", name: "Eli Lilly", zh: "礼来", address: "0x5407912F1Aa4B9E05cBE6aBeb9721547a643eC6b" },
  { symbol: "GMEB", ticker: "GME", name: "GameStop", zh: "游戏驿站", address: "0x46cEeFDa28Dd7207059ed19B0acdc026955bb15C" },
  { symbol: "SPYB", ticker: "SPY", name: "S&P 500 ETF", zh: "标普 500 ETF", address: "0x7138b48df7D98D7e3cc221BfE7192D0a178182D8", etf: true },
  { symbol: "QQQB", ticker: "QQQ", name: "Nasdaq-100 ETF", zh: "纳指 100 ETF", address: "0x205812CdBed920aFf76C6580abD681a46D11efc7", etf: true },
];

const BY_ADDR = new Map(STOCKS.map((s) => [s.address.toLowerCase(), s]));

/** the whitelisted stock behind a market page, if any (BNB Chain only) */
export const stockOf = (chain: string, address: string): Stock | undefined => (chain === "bsc" ? BY_ADDR.get(address.toLowerCase()) : undefined);

export const stockName = (s: Stock) => (walletLang() === "zh" ? s.zh : s.name);
