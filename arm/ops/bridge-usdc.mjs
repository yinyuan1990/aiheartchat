// Bridge mainnet USDC into Arc (chainId 5042) through Circle CCTP V2.
//
//   depositForBurn (source chain) -> Iris attestation -> receiveMessage (Arc)
//
// Usage (PowerShell):
//   $env:PRIVATE_KEY="0x..."; $env:FROM="base"; $env:AMOUNT="5"; node ops/bridge-usdc.mjs
//
// Env:
//   PRIVATE_KEY     signer on the source chain; also pays Arc gas for receiveMessage
//   FROM            base | ethereum | arbitrum | optimism | polygon | avalanche   (default base)
//   AMOUNT          USDC to bridge, e.g. "5" or "12.5"
//   TO              mint recipient on Arc (default: signer). Can be the Safe — anyone may call receiveMessage.
//   FAST=1          use Fast Transfer (minFinalityThreshold 1000, small fee); default is Standard (free, slower)
//   SRC_RPC_URL     override source RPC (default: viem public RPC)
//   ARC_RPC_URL     default https://rpc.arc-scan.org
//   ARC_PRIVATE_KEY separate key to pay Arc gas (default: PRIVATE_KEY)
//   RESUME_TX=0x…   skip the burn and only finish an earlier burn tx (attestation + mint on Arc)
//   CHECK=1         only print balances / fee quote, send nothing
//
// Arc charges gas in USDC: the Arc signer needs a few cents of USDC on Arc *before* the mint can be claimed.
// If it has none, the script stops after the burn and prints how to resume — the attestation does not expire quickly.

import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, pad, getAddress, defineChain, erc20Abi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, base, arbitrum, optimism, polygon, avalanche } from "viem/chains";

const ARC_DOMAIN = 26;
const TOKEN_MESSENGER_V2 = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d"; // same on every mainnet incl. Arc
const MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
const IRIS = "https://iris-api.circle.com";

const SOURCES = {
  ethereum: { chain: mainnet, domain: 0, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  base: { chain: base, domain: 6, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
  arbitrum: { chain: arbitrum, domain: 3, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
  optimism: { chain: optimism, domain: 2, usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
  polygon: { chain: polygon, domain: 7, usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
  avalanche: { chain: avalanche, domain: 1, usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" },
};

const arc = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env.ARC_RPC_URL || "https://rpc.arc-scan.org"] } },
  blockExplorers: { default: { name: "Arcscan", url: "https://explorer.arc.io" } },
});

const tokenMessengerAbi = [
  {
    type: "function", name: "depositForBurn", stateMutability: "nonpayable", outputs: [],
    inputs: [
      { name: "amount", type: "uint256" }, { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" }, { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" }, { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
  },
];
const transmitterAbi = [
  { type: "function", name: "receiveMessage", stateMutability: "nonpayable", inputs: [{ name: "message", type: "bytes" }, { name: "attestation", type: "bytes" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "localDomain", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => { console.error("\n✗ " + m); process.exit(1); };

async function main() {
  const fromKey = (process.env.FROM || "base").toLowerCase();
  const src = SOURCES[fromKey];
  if (!src) die(`FROM must be one of: ${Object.keys(SOURCES).join(", ")}`);
  const pk = process.env.PRIVATE_KEY;
  if (!pk) die("PRIVATE_KEY missing");
  const account = privateKeyToAccount(pk);
  const arcAccount = privateKeyToAccount(process.env.ARC_PRIVATE_KEY || pk);
  const recipient = getAddress(process.env.TO || account.address);
  const fast = process.env.FAST === "1";
  const check = process.env.CHECK === "1";
  const resumeTx = process.env.RESUME_TX;

  const srcPub = createPublicClient({ chain: src.chain, transport: http(process.env.SRC_RPC_URL) });
  const srcWallet = createWalletClient({ account, chain: src.chain, transport: http(process.env.SRC_RPC_URL) });
  const arcPub = createPublicClient({ chain: arc, transport: http() });
  const arcWallet = createWalletClient({ account: arcAccount, chain: arc, transport: http() });

  // ---- sanity: Arc CCTP really is domain 26 on this RPC
  const localDomain = await arcPub.readContract({ address: MESSAGE_TRANSMITTER_V2, abi: transmitterAbi, functionName: "localDomain" });
  if (Number(localDomain) !== ARC_DOMAIN) die(`Arc MessageTransmitterV2.localDomain() = ${localDomain}, expected ${ARC_DOMAIN}`);

  const [srcUsdc, srcGas, arcGas, arcUsdcBefore] = await Promise.all([
    srcPub.readContract({ address: src.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    srcPub.getBalance({ address: account.address }),
    arcPub.getBalance({ address: arcAccount.address }),
    arcPub.getBalance({ address: recipient }),
  ]);
  log(`source     ${src.chain.name} (domain ${src.domain})  signer ${account.address}`);
  log(`  USDC ${formatUnits(srcUsdc, 6)}   gas ${formatUnits(srcGas, 18)} ${src.chain.nativeCurrency.symbol}`);
  log(`arc        signer ${arcAccount.address}  gas ${formatUnits(arcGas, 18)} USDC`);
  log(`recipient  ${recipient}  arc USDC ${formatUnits(arcUsdcBefore, 18)}`);

  // ---- fee quote from Iris
  const feeRes = await fetch(`${IRIS}/v2/burn/USDC/fees/${src.domain}/${ARC_DOMAIN}`);
  if (!feeRes.ok) die(`Iris fee quote failed: ${feeRes.status} — Circle does not route ${src.domain} -> ${ARC_DOMAIN} yet`);
  const quotes = await feeRes.json(); // [{finalityThreshold, minimumFee(bps)}]
  const threshold = fast ? 1000 : 2000;
  const quote = quotes.find((q) => q.finalityThreshold === threshold) || quotes[quotes.length - 1];
  log(`iris quote ${JSON.stringify(quotes)} → using threshold ${threshold} (${fast ? "fast" : "standard"}), fee ${quote.minimumFee} bps`);

  let burnHash = resumeTx;
  if (!burnHash) {
    if (!process.env.AMOUNT) die("AMOUNT missing (USDC, e.g. 5)");
    const amount = parseUnits(process.env.AMOUNT, 6);
    // maxFee = ceil(amount * bps / 10000); Circle takes ≤ maxFee, mint = amount - fee
    const maxFee = quote.minimumFee > 0 ? (amount * BigInt(Math.ceil(quote.minimumFee * 100)) + 999_999n) / 1_000_000n : 0n;
    if (amount <= maxFee) die("amount too small for the fee");
    if (srcUsdc < amount) die(`not enough USDC on ${src.chain.name}: have ${formatUnits(srcUsdc, 6)}, need ${process.env.AMOUNT}`);
    if (srcGas === 0n) die(`no gas on ${src.chain.name}`);
    log(`plan       burn ${formatUnits(amount, 6)} USDC, maxFee ${formatUnits(maxFee, 6)} → mint ≥ ${formatUnits(amount - maxFee, 6)} USDC to ${recipient} on Arc`);
    if (check) { log("CHECK=1 — nothing sent"); return; }

    const allowance = await srcPub.readContract({ address: src.usdc, abi: erc20Abi, functionName: "allowance", args: [account.address, TOKEN_MESSENGER_V2] });
    if (allowance < amount) {
      const h = await srcWallet.writeContract({ address: src.usdc, abi: erc20Abi, functionName: "approve", args: [TOKEN_MESSENGER_V2, amount] });
      log(`approve    ${h}`);
      await srcPub.waitForTransactionReceipt({ hash: h });
    }
    burnHash = await srcWallet.writeContract({
      address: TOKEN_MESSENGER_V2, abi: tokenMessengerAbi, functionName: "depositForBurn",
      args: [amount, ARC_DOMAIN, pad(recipient, { size: 32 }), src.usdc, pad("0x", { size: 32 }), maxFee, threshold],
    });
    log(`burn       ${burnHash}  (${src.chain.blockExplorers?.default.url}/tx/${burnHash})`);
    const rc = await srcPub.waitForTransactionReceipt({ hash: burnHash });
    if (rc.status !== "success") die("burn tx reverted");
    log(`burn       confirmed in block ${rc.blockNumber}`);
  } else {
    if (check) { log("CHECK=1 with RESUME_TX — nothing sent"); return; }
    log(`resume     ${burnHash}`);
  }

  // ---- wait for Circle attestation
  log(`iris       waiting for attestation (${fast ? "~20s" : src.domain === 0 ? "~15 min on Ethereum" : "~a few minutes"})…`);
  let msg;
  for (let i = 0; ; i++) {
    const r = await fetch(`${IRIS}/v2/messages/${src.domain}?transactionHash=${burnHash}`);
    if (r.status === 404) { if (i % 6 === 0) log("iris       burn not indexed yet"); await sleep(5000); continue; }
    if (!r.ok) die(`Iris ${r.status}: ${await r.text()}`);
    const j = await r.json();
    const m = j.messages?.[0];
    if (m?.status === "complete" && m.attestation && m.attestation !== "PENDING") { msg = m; break; }
    if (i % 6 === 0) log(`iris       status=${m?.status ?? "?"}`);
    await sleep(5000);
  }
  log(`iris       attested, nonce ${msg.eventNonce}`);

  // ---- mint on Arc
  const arcGasNow = await arcPub.getBalance({ address: arcAccount.address });
  if (arcGasNow === 0n) {
    console.log(`
✗ Arc signer ${arcAccount.address} has 0 USDC on Arc and cannot pay gas for receiveMessage.
  Send ~0.05 USDC (on Arc) to it, then rerun with:
    RESUME_TX=${burnHash} FROM=${fromKey} node ops/bridge-usdc.mjs
  (the attestation stays valid; nobody else can redirect the mint — it is bound to ${recipient})`);
    process.exit(2);
  }
  const mintHash = await arcWallet.writeContract({
    address: MESSAGE_TRANSMITTER_V2, abi: transmitterAbi, functionName: "receiveMessage",
    args: [msg.message, msg.attestation],
    maxFeePerGas: parseUnits("25", 9), maxPriorityFeePerGas: parseUnits("1", 9),
  });
  log(`mint       ${mintHash}  (https://explorer.arc.io/tx/${mintHash})`);
  const mrc = await arcPub.waitForTransactionReceipt({ hash: mintHash });
  if (mrc.status !== "success") die("receiveMessage reverted (already claimed? check the explorer)");
  const arcUsdcAfter = await arcPub.getBalance({ address: recipient });
  log(`done       recipient Arc USDC ${formatUnits(arcUsdcBefore, 18)} → ${formatUnits(arcUsdcAfter, 18)}  (+${formatUnits(arcUsdcAfter - arcUsdcBefore, 18)})`);
}

main().catch((e) => die(e.shortMessage || e.message || String(e)));
