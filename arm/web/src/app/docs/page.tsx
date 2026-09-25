"use client";

import { useMemo } from "react";
import { toEventSelector } from "viem";
import { usd, useConfig } from "@/lib/api";
import { fmtUsd } from "@/lib/format";
import { EXPLORER, IS_TESTNET, NET, addrUrl, chain } from "@/lib/web3";
import { TG_HANDLE, TG_URL, X_HANDLE, X_URL } from "@/lib/site";
import { useApp } from "@/components/providers";
import { Card, CardContent } from "@/components/ui/card";
import { Addr } from "@/components/shared";
/* ------------------------------------------------------------------ content
 * The docs are long-form prose, so the bilingual copy lives here instead of i18n.ts. `L(zh, en)` picks by locale.
 */

const SECTIONS = [
  ["overview", "概览", "Overview"],
  ["launch", "代币发射流程", "How launches work"],
  ["protection", "发射保护", "Launch protection"],
  ["trading", "交易与定价", "Trading and pricing"],
  ["graduation", "毕业", "Graduation"],
  ["fees", "手续费与分润", "Fees and payouts"],
  ["standard", "标准币", "Standard tokens"],
  ["tax", "税币模式", "Tax mode"],
  ["revenue", "协议收入", "Protocol revenue"],
  ["admin", "管理员权限", "Admin powers"],
  ["risk", "风险披露", "Risk disclosures"],
  ["integration", "集成指南", "Integration"],
  ["terms", "版本与条款", "Versioning and terms"],
] as const;

const TOKEN_LAUNCHED_SIG =
  "TokenLaunched(address indexed token, address indexed deployer, address indexed pool, uint256 positionId, bool isToken0, uint256 restrictionsEndBlock, uint256 graduationThreshold, uint256 initialBuyUsdc, uint256 creationFeePaid)";
const SWAP_SIG = "Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)";

export default function DocsPage() {
  const { t, locale } = useApp();
  const L = (zh: string, en: string) => (locale === "zh" ? zh : en);
  const cfg = useConfig().data;
  const p = cfg?.params;
  const a = (cfg?.addresses ?? {}) as Record<string, string>;
  const topics = useMemo(
    () => ({
      launched: toEventSelector(`event ${TOKEN_LAUNCHED_SIG}`),
      swap: toEventSelector(`event ${SWAP_SIG}`),
    }),
    [],
  );

  const creationFee = p ? usd(p.creationFee) : 0;
  const startMcap = p ? usd(p.startMcapUsdc) : 5000;
  const threshold = p ? usd(p.graduationThreshold) : 10000;
  const protection = p?.protectionBlocks ?? 20;
  const maxHold = (p?.maxHoldBps ?? 500) / 100;
  const maxBuy = (p?.maxBuyBps ?? 550) / 100;
  const creatorPct = (p?.creatorShareBps ?? 7500) / 100;
  const maxTaxPct = (p?.maxTaxBps ?? 1000) / 100;
  const rpc = chain.rpcUrls.default.http[0];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{t("docs.title")}</h1>
        <p className="mt-1 text-sm text-secondary-foreground">{t("docs.subtitle")}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[200px_1fr]">
        <nav className="top-32 hidden self-start lg:sticky lg:block">
          <ul className="space-y-1 text-sm">
            {SECTIONS.map(([id, zh, en]) => (
              <li key={id}>
                <a href={`#${id}`} className="block rounded-md px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground">{L(zh, en)}</a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-10">
          {/* ---------------------------------------------------------- overview */}
          <Section id="overview" title={L("概览", "Overview")}>
            <P>
              {L(
                "Arm 是为 Circle Arc 公链打造的代币发射与交易平台。你可以浏览发射、打开任意代币查看详情，并直接用钱包交易。所有价格都以 USDC 计价——在 Arc 上 USDC 既是 gas 也是交易货币，你只需要一种资产。",
                "Arm is a place to launch and trade tokens on Circle's Arc network. Browse launches, open any token for details, and trade straight from your wallet. Everything is priced in USDC — on Arc, USDC is both the gas token and the quote asset, so you only ever need one asset.",
              )}
            </P>
            <P>
              <strong>{L("Arm 从不托管你的资金。", "Arm never holds your funds.")}</strong>{" "}
              {L(
                "每一次代币发射和交易都是你的钱包签名的链上交易；用户本金始终在 Uniswap V3 官方字节码的池子里，Arm 自研合约只经手手续费流。",
                "Every launch and trade is a transaction your wallet approves. User principal always sits in pools running official Uniswap V3 bytecode; Arm's own contracts only ever touch the fee stream.",
              )}
            </P>
            <Facts
              title={L("关键事实", "Key facts")}
              items={[
                L("名称和符号可以被仿冒，请始终核对合约地址。", "Names and symbols can be copied. Always check the token address."),
                L("价格来自每个代币自己的链上交易池，不是平台报价。", "Prices come from each token's live trading pool, not from us."),
                L("发射币可能剧烈波动、流动性不足或归零。", "Launches can be volatile, illiquid, or lose all value."),
              ]}
            />
          </Section>

          {/* ---------------------------------------------------------- launch */}
          <Section id="launch" title={L("代币发射流程", "How launches work")}>
            <P>
              {L(
                "代币发射是一笔交易：部署代币、创建它的 USDC 交易池、把全部供应作为单边流动性注入，并把 LP 仓位永久锁进 FeeLocker（没有解锁函数）。创作者设置名称、符号、图片、描述、社交链接和收款钱包。",
                "Creating a launch deploys the token, creates its USDC pool, seeds the whole supply as single-sided liquidity and locks the LP position in the FeeLocker forever (there is no unlock function). The creator sets the name, symbol, image, description, links and fee wallet.",
              )}
            </P>
            <P>
              {L(
                "每个代币都在自己的池子里对 USDC 交易。没有 bonding curve，之后也没有迁移。从发射那一秒起，买卖都发生在同一个池子里。",
                "Every token trades against USDC in its own pool. There is no bonding curve and no migration later. Buys and sells happen in that same pool from the moment it launches.",
              )}
            </P>
            <Steps
              steps={[
                [L("创建", "Create"), L("铸出固定 10 亿供应，USDC 池在同一笔交易内上线，开盘市值由平台统一设定。", "The token is minted with a fixed 1B supply and its USDC pool goes live in the same transaction, at the platform-wide opening market cap.")],
                [L("交易", "Trade"), L("买卖都在锁定的池子里对 USDC 进行，推动价格。", "Buys and sells run against USDC in the locked pool and move the price.")],
                [L("毕业", "Graduate"), L("池内 USDC 达到阈值即毕业；交易继续在同一个池子里。", "The launch graduates once enough USDC is paired; trading continues in the same pool.")],
              ]}
            />
            <Facts
              title={L("公平发射：统一开盘市值", "Fair launch: one opening market cap")}
              items={[
                L(
                  `每个新代币都从同一个市值开盘（当前 ${fmtUsd(startMcap, { compact: true })}），由合约计算起始价，创作者没有价格输入项。这是 pons 上没有的规则：pons 允许创作者自己选开盘价。`,
                  `Every new token opens at the same market cap (currently ${fmtUsd(startMcap, { compact: true })}); the contract derives the starting price and creators have no price input. pons, by contrast, lets creators pick their own opening price.`,
                ),
                L("这个数值是合约常量，管理员也改不了。", "This value is a contract constant — not even the admin can change it."),
              ]}
            />
            <KvGrid
              rows={[
                [L("总供应", "Supply"), "1,000,000,000 (1e9)"],
                [L("池费率", "Pool fee"), "1% (10000)"],
                [L("创建费", "Launch fee"), creationFee > 0 ? `${fmtUsd(creationFee)} USDC · ${L("合约常量，不可改", "contract constant, immutable")}` : L("免费（合约常量 0）", "Free (contract constant 0)")],
                [L("开盘市值", "Opening market cap"), `${fmtUsd(startMcap, { compact: true })} USDC`],
                [L("创作者首购", "Creator first buy"), L("可选，在发射区块内执行", "Optional, executes inside the launch block")],
                [L("收款钱包", "Fee wallet"), L("可选，默认为发射钱包", "Optional, defaults to the deploying wallet")],
              ]}
            />
          </Section>

          {/* ---------------------------------------------------------- protection */}
          <Section id="protection" title={L("发射保护", "Launch protection")}>
            <P>
              {L(
                `发射后的前 ${protection} 个区块（Arc 0.5 秒出块，约 ${Math.round(protection / 2)} 秒）内，从池子买出受限制：发射区块本身只有创作者的首购可以成交；窗口内每个钱包最多持有总供应的 ${maxHold}%，单笔最多买入 ${maxBuy}%。`,
                `Buys from the pool are protected for the first ${protection} blocks after launch (Arc produces a block every 0.5s, so roughly ${Math.round(protection / 2)} seconds). On the launch block itself only the creator's initial buy can execute. For the rest of the window each wallet can hold at most ${maxHold}% of supply and buy at most ${maxBuy}% per transaction.`,
              )}
            </P>
            <P>{L("卖出和钱包间转账永不受限；窗口结束后所有限制解除。", "Selling and wallet-to-wallet transfers are never restricted, and all limits end once the window closes.")}</P>
          </Section>

          {/* ---------------------------------------------------------- trading */}
          <Section id="trading" title={L("交易与定价", "Trading and pricing")}>
            <P>
              {L(
                "你看到的价格是池子的实时价格，每一笔交易都会移动它。实际到手数量可能与报价略有差异；滑点设置决定你接受多大的偏差。",
                "The price you see is the live pool price, and it moves with each trade. The amount you actually receive can differ slightly from the quote. Slippage sets how much of that movement you accept.",
              )}
            </P>
            <Glossary
              items={[
                [L("价格", "Price"), L("池子里 1 个代币当前值多少 USDC。", "The current pool price for one token, in USDC.")],
                [L("市值", "Market cap"), L("价格 × 流通供应（总供应减去已销毁）。", "Price × circulating supply (total minus burned).")],
                [L("完全稀释市值 FDV", "FDV"), L("价格 × 总供应。供应固定，未销毁时等于市值。", "Price × full supply. Supply is fixed, so it equals market cap unless tokens were burned.")],
                [L("价格影响", "Price impact"), L("你这笔交易的大小对池子价格造成的移动。", "The pool movement caused by the size of your trade.")],
                [L("滑点", "Slippage"), L("你允许成交价偏离报价的最大幅度，超过则回滚。", "The maximum execution movement your transaction accepts before reverting.")],
                [L("流动性", "Liquidity"), L("池内 USDC 加上池内代币按现价折算的美元价值。", "USDC in the pool plus the pool's tokens valued at the current price.")],
              ]}
            />
          </Section>

          {/* ---------------------------------------------------------- graduation */}
          <Section id="graduation" title={L("毕业", "Graduation")}>
            <P>
              {L(
                `当锁定池内配对的 USDC 达到阈值（当前 ${fmtUsd(threshold, { compact: true })}）即毕业。进度条显示离毕业还有多远。`,
                `A launch graduates once the USDC paired in its locked pool reaches the threshold (currently ${fmtUsd(threshold, { compact: true })}). The progress line tracks how close a launch is.`,
              )}
            </P>
            <P>
              {L(
                "毕业只确认阈值达到了。它不是质量信号，也不保证未来的流动性、价格或退出机会。毕业后交易继续在同一个池子里，什么都不会迁移，手续费和分成也不变。",
                "Graduation only confirms the threshold was reached. It is not a quality signal and does not guarantee future liquidity, price, or an exit. Trading continues in the same pool after graduation. Nothing moves or migrates; fees and the creator split are unchanged.",
              )}
            </P>
          </Section>

          {/* ---------------------------------------------------------- fees */}
          <Section id="fees" title={L("手续费与分润", "Fees and payouts")}>
            <P>
              {L(
                `每笔交易产生 1% 池手续费。协议留 ${100 - creatorPct}%，创作者拿 ${creatorPct}%。这个比例在发射时快照进合约，之后永不改变——毕业前后一样。`,
                `Trading generates a 1% pool fee. The protocol keeps ${100 - creatorPct}% and the creator keeps ${creatorPct}%. The split is snapshotted for each token when it launches and never changes afterward — before and after graduation alike.`,
              )}
            </P>
            <Facts
              title={L("创作者只收 USDC，自动到账", "Creators receive USDC only, automatically")}
              items={[
                L(
                  "V3 仓位同时累积代币侧和 USDC 侧手续费。分发时，代币侧手续费先在同一个池子里卖成 USDC，再合并按比例分。创作者和协议侧都只收到 USDC。",
                  "A V3 position accrues fees on both the token and the USDC side. At distribution the token-side fees are sold into the same pool for USDC first, then everything is split. Creators and the protocol only ever receive USDC.",
                ),
                L(
                  "Keeper 定期调用 distribute()（任何人也可以调用），把分成直接推送到创作者的收款钱包。如果推送失败（例如地址被 USDC 黑名单），金额留在合约里可手动领取。",
                  "A keeper calls distribute() on a schedule (anyone can call it) and pushes the share straight to the creator's payout wallet. If the push fails (e.g. the address is on the USDC blocklist) the amount is parked as claimable.",
                ),
                L(
                  "如果代币侧换汇失败（滑点保护未满足），代币暂存等下次重试，USDC 部分照常发放。",
                  "If the token-side swap fails (slippage guard) the tokens are kept for the next attempt; the USDC part is paid out regardless.",
                ),
                L(
                  "收款钱包可以在发射时指定，之后由当前收款地址随时即时更换（创作者中心）。",
                  "The fee wallet can be set at launch and rotated instantly at any time by the current payout address (creator center).",
                ),
              ]}
            />
          </Section>

          {/* ---------------------------------------------------------- standard */}
          <Section id="standard" title={L("标准币", "Standard tokens")}>
            <P>
              {L(
                "标准币是发射页的默认选项：一个最朴素的 ERC-20，没有任何附加逻辑。转账多少到多少，合约不扣、不加、不拦。交易成本只有 Uniswap V3 的 1% 池费，创作者的收益也只来自这 1% 里的分成。",
                "Standard is the default option on the launch page: a plain ERC-20 with no extra logic. What you send is what arrives — the contract never deducts, adds or blocks. The only trading cost is the Uniswap V3 1% pool fee, and the creator's income comes solely from their share of that fee.",
              )}
            </P>
            <Glossary
              items={[
                [L("固定供应", "Fixed supply"), L("每个代币总量 10 亿，发射时一次铸完，全部注入 V3 池。合约没有 mint 函数，之后任何人都无法增发。", "Every token has a total supply of 1 billion, minted once at launch and placed entirely into the V3 pool. There is no mint function, so nobody can ever inflate it.")],
                [L("LP 永久锁定", "LP locked forever"), L("代表流动性的 V3 仓位 NFT 由 FeeLocker 持有，合约里没有取出函数，创作者和平台都拿不走池子里的钱。", "The V3 position NFT that represents the liquidity is held by the FeeLocker, which has no withdraw function; neither the creator nor the platform can pull the pool.")],
                [L("零税、零特权", "No tax, no privileges"), L("买入税和卖出税都是 0，没有黑名单、暂停、手续费开关或所有者后门。代币合约不可升级，发射那一刻的代码就是它永远的代码。", "Buy and sell tax are both zero. There is no blocklist, pause, fee switch or owner backdoor. The token contract is not upgradeable — the code at launch is the code forever.")],
                [L("创作者能决定什么", "What the creator controls"), L(`只有发射时的元数据（名称、符号、logo、简介、社交链接）、收款钱包和可选的首购金额。之后能做的只有更换收款地址。每笔交易 1% 池费里的 ${creatorPct}% 会自动以 USDC 打到收款钱包。`, `Only the launch-time metadata (name, symbol, logo, description, socials), the payout wallet and an optional first buy. Afterwards the only lever left is rotating the payout wallet. ${creatorPct}% of every 1% pool fee is paid to that wallet automatically, in USDC.`)],
              ]}
            />
            <Facts
              items={[
                L("不确定选哪种就选标准币：交易者最容易看懂，钱包和聚合器也不需要任何特殊处理。", "If in doubt, launch a standard token: it is the easiest for traders to reason about and needs no special handling by wallets or aggregators."),
                L("需要给营销或团队持续供血、且愿意让买卖双方承担额外成本时，再考虑下一节的税币模式。", "Consider tax mode (next section) only when you need an ongoing marketing or team budget and are willing to make buyers and sellers pay for it."),
                L("模式在发射时一次选定，标准币之后不能改成税币，税币也不能改回标准币。", "The mode is chosen once at launch: a standard token cannot become a tax token later, and vice versa."),
              ]}
            />
          </Section>

          {/* ---------------------------------------------------------- tax */}
          <Section id="tax" title={L("税币模式", "Tax mode")}>
            <P>
              {L(
                `发射时可以选"税币"：在 1% 池费之外，每笔买入和卖出再收一笔由创作者设定的税（各最高 ${maxTaxPct}%，上限是合约常量）。税率和流向写进代币合约的 immutable 字段，发射后任何人——包括平台管理员——都无法修改。标准币的税率为 0，合约不改动任何转账金额。`,
                `At launch a creator may choose "tax mode": on top of the 1% pool fee, every buy and sell pays a creator-set tax (up to ${maxTaxPct}% each; the cap is a contract constant). Rates and allocation are immutable fields on the token contract — nobody, including the platform admin, can change them after launch. Standard tokens have zero tax and never touch transfer amounts.`,
              )}
            </P>
            <Glossary
              items={[
                [L("买入税", "Buy tax"), L("池子按报价原量转出，代币合约从中扣税，买家实收 = 报价 × (1 − 税率)。前端显示的是税后实收。", "The pool sends the quoted amount; the token deducts the tax from it, so the buyer receives quote × (1 − rate). The UI shows the after-tax amount.")],
                [L("卖出税", "Sell tax"), L("池子足额收到你卖的 N 个；税额外从你的余额扣 N × 税率。因此卖 N 个需要 N × (1 + 税率) 的余额，最大可卖 = 余额 ÷ (1 + 税率)。这样设计是为了兼容 Uniswap V3 对池子实收金额的校验，交易不会回滚。", "The pool receives the full N you sell; the tax N × rate is charged on top from your balance. Selling N therefore needs N × (1 + rate); max sellable = balance ÷ (1 + rate). This keeps Uniswap V3's received-amount check satisfied so swaps never revert.")],
                [L("分配：营销税 / 团队税", "Allocation: marketing / team"), L("创作者在发射时填两个地址（营销钱包、团队钱包）和一个比例，买卖两边的税都按这个比例分。税代币进入 FeeLocker，由 Keeper 与手续费一起卖成 USDC 后自动打到这两个地址；协议不抽成。", "At launch the creator sets two wallets (marketing, team) and one ratio; buy and sell taxes are both split that way. Tax tokens go to the FeeLocker, are sold for USDC together with fees, and paid out automatically to the two wallets; the protocol takes no cut.")],
                [L("不可修改", "Immutable"), L("税率、两个地址和比例都是代币合约的 immutable 字段。地址失效（例如被 USDC 黑名单）时该份 USDC 留在 FeeLocker 可由该地址 claim，不会阻塞其他人的分发。", "Rates, both wallets and the ratio are immutable fields on the token. If a wallet cannot receive (e.g. USDC blocklist) its share is parked in the FeeLocker as claimable and never blocks anyone else's payout.")],
              ]}
            />
            <Facts
              items={[
                L("协议从税里拿 0；协议收入只来自池费的 0.22%（Arm 发币免费）。", "The protocol takes 0 of the tax; protocol revenue is only the 0.22% pool-fee share (launching on Arm is free)."),
                L("FeeLocker、结算合约、PositionManager 等系统地址免税，分费换汇不受影响。", "System addresses (FeeLocker, settlement contract, PositionManager) are exempt, so fee conversion is unaffected."),
                L("税币在列表和代币页有金色徽章「买 x% · 卖 y%」，交易面板会逐行列出税额。请在买入前看清。", "Tax tokens carry a gold “Buy x% · Sell y%” badge in lists and on the token page, and the trade panel itemises the tax. Check before you buy."),
                L("对比 dyorswap：它的税币只能迁到 Uniswap V2、收款钱包固定为发射钱包；Arm 的税币从第一秒就在 V3 池里交易，营销 / 团队两个地址可自由填写（多签、冷钱包均可），分红档暂不提供。", "Versus dyorswap: its tax tokens can only migrate to Uniswap V2 and pay the deployer wallet; Arm tax tokens trade in a V3 pool from the first second, the marketing / team wallets are free-form (multisig or cold wallet), and a holder-dividend option is not offered."),
              ]}
            />
          </Section>

          {/* ---------------------------------------------------------- revenue */}
          <Section id="revenue" title={L("协议收入", "Protocol revenue")}>
            <P>
              {L(
                "每笔交易 1% 池费的分配：项目方 / 创作者 78%、储备金 16%、回购基金 5%、开发团队 1%。创作者的 0.78% 由 FeeLocker 直接打到创作者钱包；其余 0.22% 进入自动结算合约，每 7 天结算一次（任何人可调用 execute()，Keeper 到点自动触发）：0.16% 转入储备金多签，0.05% 转入回购基金多签，0.01% 转入开发团队地址。结算合约本身不做任何交易。发币免费，不收创建费。平台不设资金池：所有收入的终点只有两个多签和开发团队地址。比例、7 天周期、三个收款地址都写死在合约里不可更改。",
                "Every trade's 1% pool fee is split: project / creator 78%, reserve 16%, buyback fund 5%, dev team 1%. The creator's 0.78% is paid straight to the creator's wallet by the FeeLocker; the other 0.22% flows into the automatic settlement contract that settles every 7 days (anyone can call execute(); the keeper triggers it on schedule): 0.16% to the reserve multisig, 0.05% to the buyback-fund multisig, 0.01% to the dev team wallet. The settlement contract never trades on its own. Launching is free: there is no creation fee. The platform keeps no fund pool: every dollar ends up in one of the two multisigs or the dev wallet. The ratios, the 7-day cadence and all three payout addresses are immutable.",
              )}
            </P>
            <KvGrid
              rows={[
                [L("项目方 / 创作者", "Project / creator"), L("每笔 1% 池费的 78%（0.78%），FeeLocker 直付，毕业前后不变", "78% of the 1% fee (0.78%), paid directly by the FeeLocker, unchanged after graduation")],
                [L("储备金（多签）", "Reserve (multisig)"), L("每笔 1% 池费的 19%（0.16%）+ 全部创建费：创作者激励、运营、审计", "19% of the 1% fee (0.16%) + all creation fees: creator incentives, operations, audits")],
                [L("回购基金（多签）", "Buyback fund (multisig)"), L("每笔 1% 池费的 5%（0.05%），每 7 天转入，由平台方多签持有和使用", "5% of the 1% fee (0.05%), transferred every 7 days, held and used by the platform multisig")],
                [L("开发团队", "Dev team"), L("每笔 1% 池费的 1%（0.01%），单地址，部署时写死", "1% of the 1% fee (0.01%), single address fixed at deployment")],
              ]}
            />
          </Section>

          {/* ---------------------------------------------------------- admin */}
          <Section id="admin" title={L("管理员权限", "Admin powers")}>
            <P>{L("合约不可升级。管理员（后续将转为多签）能做和不能做的事全部公开：", "Contracts are not upgradeable. What the admin (a multisig later) can and cannot do is fully public:")}</P>
            <div className="grid gap-3 md:grid-cols-2">
              <Facts
                title={L("可以", "Can")}
                items={[
                  L("把结算合约里误转入的其他代币换成 USDC（正常流程用不到）", "Convert stray tokens that land in the settlement contract into USDC (never needed in normal operation)"),
                  L("更换手续费合约指向的工厂（只在部署新版工厂时用）", "Point the fee contract at a new factory (only used when a new factory version is deployed)"),
                ]}
              />
              <Facts
                title={L("做不到", "Cannot")}
                items={[
                  L("动池子里的钱、动 LP、取回流动性", "Touch pool funds, the LP position, or withdraw liquidity"),
                  L("改任何收款地址：储备金、回购、开发团队地址和协议 22% 收款合约都在部署时写死", "Change any payout address: the reserve, buyback and dev wallets and the protocol-share collector are fixed at deployment"),
                  L("改任何已发射代币的 78/22 分成", "Change the 78/22 split of any launched token"),
                  L("增发、冻结、暂停交易、升级合约", "Mint, freeze, pause trading, or upgrade contracts"),
                  L("以任何方式改动创作者收款地址——合约里没有这条路径，只有当前收款地址自己能换", "Change a creator's payout address in any way — there is no such path in the contract; only the current payout wallet can rotate it"),
                  L("修改任何已发射代币的税率或税费流向", "Change the tax rate or allocation of any launched token"),
                  L("改 78/16/5/1 分配比例、7 天周期、10 亿供应、1% 池费", "Change the 78/16/5/1 split, the 7-day cadence, the 1B supply, or the 1% pool fee"),
                  L("开始收创建费（永远是 0）、改 10% 税率上限——都是合约常量，没有白名单", "Start charging a creation fee (it is always 0) or change the 10% tax cap — both are constants, there is no whitelist"),
                  L("改开盘市值（$5,000）、毕业阈值（10,000 USDC）、保护窗口（20 块）、限购比例（5% / 5.5%）——全部是合约常量，没有任何设置函数", "Change the opening mcap ($5,000), graduation threshold (10,000 USDC), protection window (20 blocks) or buy caps (5% / 5.5%) — all constants, there is no setter"),
                ]}
              />
            </div>
          </Section>

          {/* ---------------------------------------------------------- risk */}
          <Section id="risk" title={L("风险披露", "Risk disclosures")}>
            <P>
              {L(
                "通过 Arm 发射的代币由用户创建，属于实验性资产。签名前请核对代币地址、创作者、流动性、持有人集中度和交易预览。",
                "Tokens launched through Arm are user-created and experimental. Review the token address, creator, liquidity, holder concentration, and transaction preview before signing.",
              )}
            </P>
            <Facts
              items={[
                L("价格可能剧烈波动，流动性可能很薄。", "Prices can move quickly and liquidity can be thin."),
                L("相似的名称和图片可能是毫不相关的代币。", "Similar names and images can represent unrelated tokens."),
                L("智能合约、钱包、RPC 和索引器都可能故障。", "Smart contracts, wallets, RPCs, and indexers can fail."),
                L("页面显示的数值是估算，不是成交保证。", "Displayed values are estimates, not execution guarantees."),
                L("主网开放时尚未完成第三方审计；已完成单元测试、E2E 与静态分析。用户本金在 Uniswap V3 官方字节码合约内。", "At mainnet launch no third-party audit has been completed yet; unit tests, E2E and static analysis have. User principal sits in official Uniswap V3 bytecode."),
              ]}
            />
            <P className="text-muted-foreground">{L("Arm 只是一个界面，不构成投资建议，也不代表对任何代币质量的判断。", "Arm is an interface, not investment advice or a representation of token quality.")}</P>
          </Section>

          {/* ---------------------------------------------------------- integration */}
          <Section id="integration" title={L("集成指南", "Integration")}>
            <P>
              {L(
                "一切都直接从合约读取。索引 Factory 和池子的事件即可获得最小信任的链上事实源。",
                "Everything reads directly off the contracts. Index factory and pool events for a trust-minimized onchain source of truth.",
              )}
            </P>
            <H3>{L("网络", "Network")}</H3>
            <KvGrid
              rows={[
                [L("网络", "Network"), `Arc ${t(`common.net.${NET}`)}`],
                ["Chain ID", String(cfg?.chainId ?? chain.id)],
                [L("原生资产", "Native asset"), "USDC (18dp native · 6dp ERC-20)"],
                [L("公共 RPC", "Public RPC"), <code key="rpc" className="font-mono text-xs">{rpc}</code>],
                [L("浏览器", "Explorer"), <a key="ex" href={EXPLORER} target="_blank" rel="noreferrer" className="text-primary hover:underline">{EXPLORER}</a>],
                [L("池费率", "Pool fee"), "10000 (1%)"],
                [L("供应", "Supply"), "1,000,000,000 (1e9 · 18dp)"],
              ]}
            />
            <H3>{L("合约地址", "Contracts")}</H3>
            <KvGrid
              rows={[
                ["LaunchFactory", <AddrLink key="f" a={a.launchFactory} />],
                ["FeeLocker", <AddrLink key="l" a={a.feeLocker} />],
                ["Treasury", <AddrLink key="t" a={a.treasury} />],
                ["USDC (quote token)", <AddrLink key="u" a={a.usdc} />],
                ["Uniswap V3 Factory", <AddrLink key="v" a={a.uniswapV3Factory} />],
                ["NonfungiblePositionManager", <AddrLink key="p" a={a.positionManager} />],
                ["SwapRouter", <AddrLink key="s" a={a.swapRouter} />],
                ["QuoterV2", <AddrLink key="q" a={a.quoterV2} />],
                [L("起始区块", "Start block"), String(a.deployBlock ?? "")],
              ]}
            />
            <H3>{L("链上事件", "Onchain events")}</H3>
            <P>
              {L(
                "索引 Factory 的 TokenLaunched 事件，登记每个 pool，然后索引池子的 Swap 事件。链上事件是权威数据源。没有迁移事件；毕业轮询 graduationStatus(token)，持有人余额可选索引代币 Transfer。",
                "Index the factory's TokenLaunched event, register each emitted pool, and index its Swap events. Onchain events are the authoritative source of truth. There is no migration event; poll graduationStatus(token) for graduation and optionally index token Transfer events for holder balances.",
              )}
            </P>
            <KvGrid
              rows={[
                ["TokenLaunched (topic0)", <code key="a" className="font-mono text-[11px] break-all">{topics.launched}</code>],
                ["Swap (topic0)", <code key="b" className="font-mono text-[11px] break-all">{topics.swap}</code>],
              ]}
            />
            <Code title={L("用 viem 读取发射", "Read launches with viem")}>{`import { createPublicClient, http, parseAbiItem } from "viem";
import { ${IS_TESTNET ? "arcTestnet" : "arc"} } from "viem/chains";

const client = createPublicClient({ chain: ${IS_TESTNET ? "arcTestnet" : "arc"}, transport: http("${rpc}") });

const launches = await client.getLogs({
  address: "${a.launchFactory ?? "0x…"}",
  event: parseAbiItem(
    "event ${TOKEN_LAUNCHED_SIG}",
  ),
  fromBlock: ${a.deployBlock ?? 0}n,
  toBlock: "latest",
});
// The public RPC times out on wide eth_getLogs ranges — backfill in bounded chunks (≤ 2000 blocks).`}</Code>
            <Code title={L("买卖方向", "Buy or sell side")}>{`// isToken0 comes straight from the TokenLaunched event
usdcDelta = isToken0 ? amount1 : amount0   // signed, from the Swap event
side      = usdcDelta > 0 ? "buy" : "sell" // USDC flowing into the pool = buy`}</Code>
            <H3>{L("定价与毕业", "Pricing and graduation")}</H3>
            <P>
              {L(
                "价格来自池子的 slot0。把 sqrtPriceX96 平方，按代币排序取倒数——注意发射币是 18 位、USDC 是 6 位，需要 10^12 缩放。pons 两边都是 18 位，它的公式不能照抄。",
                "Price comes from the pool's slot0. Square sqrtPriceX96 and invert it when the token is not token0 — and mind the decimals: launch tokens are 18dp, USDC is 6dp, so a 10^12 scale applies. pons has 18dp on both sides, so its formula does not carry over.",
              )}
            </P>
            <Code title={L("价格、市值、FDV", "Price, market cap and FDV")}>{`const [sqrtPriceX96] = await client.readContract({ address: pool, abi: slot0Abi, functionName: "slot0" });

const ratio = Number(sqrtPriceX96) / 2 ** 96;   // sqrt(token1 raw units per token0 raw unit)
const raw   = ratio * ratio;                      // token1 per token0, raw units
// token is 18dp, USDC is 6dp → scale by 1e12
const priceUsdc = isToken0 ? raw * 1e12 : 1e12 / raw;

const supplyTokens = 1e9;
const fdvUsd       = priceUsdc * supplyTokens;
const burned       = Number(await balanceOf(token, "0x000000000000000000000000000000000000dEaD")) / 1e18;
const mcapUsd      = priceUsdc * (supplyTokens - burned);`}</Code>
            <Code title={L("毕业状态", "Graduation status")}>{`const [paired, threshold, graduated] = await client.readContract({
  address: factory,
  abi: [parseAbiItem("function graduationStatus(address token) view returns (uint256 paired, uint256 threshold, bool graduated)")],
  functionName: "graduationStatus",
  args: [token],
});
const progress = Number(paired) / Number(threshold); // 0 → 1`}</Code>
            <Code title={L("分成与收款地址", "Fee split and payout")}>{`// locks(token) → (tokenId, token, quote, pool, creator, payout, creatorShareBps, exists)
const lock = await client.readContract({ address: locker, abi: lockerAbi, functionName: "locks", args: [token] });
const creatorSharePercent = Number(lock[6]) / 100;  // 75
const creatorPayout       = lock[5];                 // may differ from the deployer`}</Code>
            <H3>{L("代币自描述", "Self-describing tokens")}</H3>
            <Code>{`const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function logo() view returns (string)",
  "function description() view returns (string)",
  "function liquidityPool() view returns (address)",
  "function deployer() view returns (address)",
  "function restrictionsEndBlock() view returns (uint256)",
  "function socials() view returns (string website, string twitter, string telegram, string discord, string farcaster)",
  // tax mode (0/0 = standard token); all immutable
  "function taxConfig() view returns (uint16 buyBps, uint16 sellBps, address marketing, address team, uint16 marketingShareBps)",
]);`}</Code>
            <H3>{L("REST / WebSocket", "REST / WebSocket")}</H3>
            <P>
              {L(
                "Arm 自己的索引器也对外开放，方便快速接入（非权威源，以链上为准）：",
                "Arm's own indexer is public for quick integrations (not authoritative — the chain is):",
              )}
            </P>
            <KvGrid
              rows={[
                ["GET /api/tokens?sort=volume&filter=all&window=24h", L("代币列表", "Token list")],
                ["GET /api/tokens/:address", L("代币详情（价格、市值、FDV、流动性、销毁）", "Token detail (price, mcap, FDV, liquidity, burned)")],
                ["GET /api/tokens/:address/candles?interval=1m", L("K 线", "Candles")],
                ["GET /api/tokens/:address/trades · /holders", L("成交与持有人", "Trades and holders")],
                ["GET /api/stats · /treasury · /health", L("平台统计、结算记录、同步状态", "Platform stats, settlement history, sync state")],
                ["WS /ws", L("trade / launch / fees / graduated / settlement 实时推送", "Live trade / launch / fees / graduated / settlement events")],
              ]}
            />
          </Section>

          {/* ---------------------------------------------------------- terms */}
          <Section id="terms" title={L("版本与条款", "Versioning and terms")}>
            <H3>{L("版本", "Versioning")}</H3>
            <P>
              {L(
                "已部署的合约不可变。新版本以新的 Factory / Locker 地址发布并列在上方合约表中；老代币留在原合约里继续交易，不会被搬动。官方 Uniswap V4 在 Arc 上线后，新 Factory 可能走 V4，同样不影响已发代币。",
                "Deployed contracts are immutable. New versions ship as new Factory / Locker addresses listed under Contracts; tokens launched on an older version keep trading there and are never moved. Once official Uniswap V4 is live on Arc a new factory may target it, again without touching existing tokens.",
              )}
            </P>
            <H3>{L("条款", "Terms")}</H3>
            <P>
              {L(
                "链上数据公开免费，如何使用由你负责。Arm 按现状提供，不作任何担保；团队不对因集成、界面、RPC 或索引器造成的损失负责。引用 Arm 时请链接回本站，未经书面同意不得暗示合作、背书或官方身份，不得以误导用户的方式使用 Arm 名称或标识。Arm 不是 Arc 或 Circle 的官方产品。",
                "Onchain data is public and free to read; you are responsible for how you use it. Arm is provided as is, without warranties, and the team is not liable for losses arising from integrations, interfaces, RPCs, or indexers. When referencing Arm, link back to the app; do not imply a partnership, endorsement, or official status without written agreement, and do not use the Arm name or marks in a misleading way. Arm is not an official Arc or Circle product.",
              )}
            </P>
            <H3>{L("社区与支持", "Community and support")}</H3>
            <KvGrid
              rows={[
                ["X", <a key="x" href={X_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">@{X_HANDLE}</a>],
                ["Telegram", <a key="tg" href={TG_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">t.me/{TG_HANDLE}</a>],
              ]}
            />
            <P>
              {L("集成、索引、定价或链上状态问题，请到 Telegram 群 ", "For integration, indexing, pricing or onchain-state questions, ask in the Telegram group ")}
              <a href={TG_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">@{TG_HANDLE}</a>
              {L(" 或通过 X 私信 ", " or DM us on X: ")}
              <a href={X_URL} target="_blank" rel="noreferrer" className="text-primary hover:underline">@{X_HANDLE}</a>.
            </P>
          </Section>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ building blocks */

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-32 space-y-3">
      <h2 className="text-lg font-semibold tracking-tight md:text-xl">{title}</h2>
      {children}
    </section>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return <h3 className="pt-2 text-sm font-semibold">{children}</h3>;
}

function P({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={`text-sm leading-relaxed text-secondary-foreground ${className ?? ""}`}>{children}</p>;
}

function Facts({ title, items }: { title?: string; items: string[] }) {
  return (
    <Card size="sm">
      <CardContent>
        {title && <div className="label mb-2">{title}</div>}
        <ul className="space-y-1.5 text-sm text-secondary-foreground">
          {items.map((x, i) => (
            <li key={i} className="flex gap-2"><span className="mt-2 size-1 shrink-0 rounded-full bg-primary" />{x}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function Steps({ steps }: { steps: [string, string][] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {steps.map(([h, d], i) => (
        <Card key={h} size="sm">
          <CardContent>
            <div className="font-mono text-xs text-primary">0{i + 1}</div>
            <div className="mt-1 font-semibold">{h}</div>
            <p className="mt-1 text-xs leading-relaxed text-secondary-foreground">{d}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Glossary({ items }: { items: [string, string][] }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="rounded-lg bg-muted p-3 text-sm">
          <div className="font-semibold">{k}</div>
          <div className="mt-0.5 text-xs leading-relaxed text-secondary-foreground">{v}</div>
        </div>
      ))}
    </div>
  );
}

function KvGrid({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <Card className="py-0">
      <div className="divide-y text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2">
            <span className="text-muted-foreground">{k}</span>
            <span className="min-w-0 text-right font-mono text-xs tabular">{v}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Code({ title, children }: { title?: string; children: string }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/60">
      {title && <div className="border-b px-3 py-1.5 text-[11px] text-muted-foreground">{title}</div>}
      <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed">{children}</pre>
    </div>
  );
}

function AddrLink({ a }: { a?: string }) {
  if (!a) return <span className="text-muted-foreground">…</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <Addr value={a} head={10} tail={8} />
      <a href={addrUrl(a)} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground">↗</a>
    </span>
  );
}
