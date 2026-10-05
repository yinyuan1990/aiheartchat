import { hasFeature, nativeBridge } from "./native";
import { t } from "./i18n";
import { accountOf, type Secret } from "./vault";
import { b64, signBytes, solKeypairOf } from "./sol";
import { tronKeyOf } from "./tron";
import { signTonText, tonKeyOf } from "./ton";

/**
 * 「允许好友给我转账」: the wallet's receiving addresses published to the 心之音 account, so a chat friend can pay
 * without asking for an address. Each address is proven with a signature over the exact text the backend checks
 * (houduan/src/user/chain-address.ts `addressMessage`), so a stolen login cannot swap in someone else's address.
 */

/** `ton` undefined: the shell dropped the field (an iOS shell from before TON), so it is unknown rather than off */
export type Payee = { userId: string; evm: string | null; sol: string | null; trx: string | null; ton?: string | null };

export const addressMessage = (userId: string, evm: string | null, sol: string | null, trx: string | null, ton: string | null, ts: number) =>
  `心之音收款地址\nuser: ${userId}\nevm: ${evm ?? "-"}\nsol: ${sol ?? "-"}\ntrx: ${trx ?? "-"}\nton: ${ton ?? "-"}\nts: ${ts}`;

/** Payer proof for a chat transfer card, signed with the paying key (houduan chain-address.ts `transferMessage`). */
export const transferMessage = (hash: string, from: string, to: string) => `心之音转账\nhash: ${hash}\nfrom: ${from}\nto: ${to}`;

export const payeeSupported = () => hasFeature("chat") && !!nativeBridge()?.chainAddress;

const parse = (r: unknown): Payee => {
  const o = (typeof r === "string" ? JSON.parse(r) : r) as Partial<Payee> & { message?: string; statusCode?: number };
  if (!o || typeof o.userId !== "string") throw new Error(o?.message ?? t("cw.payee.noResponse", { app: t("app.name") }));
  return { userId: o.userId, evm: o.evm ?? null, sol: o.sol ?? null, trx: o.trx ?? null, ton: "ton" in o ? (o.ton ?? null) : undefined };
};

export async function loadPayee(): Promise<Payee | null> {
  const b = nativeBridge();
  if (!payeeSupported() || !b?.chainAddress) return null;
  return parse(await b.chainAddress(null));
}

/** Publishes the EVM and TRON addresses (and the Solana / TON ones for mnemonic wallets) of `secret`. TRON keys are
 * secp256k1: the TRON address signs the same text EVM-style and the backend maps the recovered 0x address to T….
 * TON signs with ed25519 and sends its public key along: the backend rebuilds the W5 address from it. */
export async function publishPayee(userId: string, secret: Secret): Promise<Payee> {
  const account = accountOf(secret);
  const kp = solKeypairOf(secret);
  const tron = tronKeyOf(secret);
  const ton = tonKeyOf(secret);
  const ts = Date.now();
  const msg = addressMessage(userId, account.address, kp?.address ?? null, tron.address, ton?.address ?? null, ts);
  const body = {
    evm: account.address,
    sol: kp?.address ?? null,
    trx: tron.address,
    ton: ton?.address ?? null,
    ts,
    evmSig: await account.signMessage({ message: msg }),
    solSig: kp ? b64.encode(signBytes(new TextEncoder().encode(msg), kp)) : undefined,
    trxSig: await tron.account.signMessage({ message: msg }),
    tonSig: ton ? signTonText(ton, msg) : undefined,
  };
  return parse(await nativeBridge()!.chainAddress!(body));
}

export async function unpublishPayee(): Promise<Payee> {
  return parse(await nativeBridge()!.chainAddress!({ off: true }));
}
