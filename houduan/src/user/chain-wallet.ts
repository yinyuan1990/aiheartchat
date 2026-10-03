import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 链上钱包入口开关（钱包本身是自托管的网页钱包，私钥只在用户设备上，这里只决定 App 里显不显示入口）。
 * 全局 sys_setting.chain_wallet_mode：off = 谁都看不到；per_user = 只有 user.wallet_enabled 的人（默认）；all = 所有人。
 * 关掉入口冻结不了用户的钱，App 端对已建过钱包的人仍保留导出 / 转出入口。
 */
export const KEY_CHAIN_WALLET_MODE = 'chain_wallet_mode';
export const CHAIN_WALLET_MODES = ['off', 'per_user', 'all'] as const;
export type ChainWalletMode = (typeof CHAIN_WALLET_MODES)[number];

/** 钱包页面地址（App 壳用 WebView 打开），可用 sys_setting.chain_wallet_url 覆盖 */
export const KEY_CHAIN_WALLET_URL = 'chain_wallet_url';
export const DEFAULT_CHAIN_WALLET_URL = 'https://arm.yyheart.com/wallet';

export async function chainWalletMode(prisma: PrismaService): Promise<ChainWalletMode> {
  const row = await prisma.sysSetting.findUnique({ where: { key: KEY_CHAIN_WALLET_MODE } });
  return (CHAIN_WALLET_MODES as readonly string[]).includes(row?.value ?? '') ? (row!.value as ChainWalletMode) : 'per_user';
}

export async function chainWalletUrl(prisma: PrismaService): Promise<string> {
  const row = await prisma.sysSetting.findUnique({ where: { key: KEY_CHAIN_WALLET_URL } });
  return row?.value || DEFAULT_CHAIN_WALLET_URL;
}

export async function chainWalletFeature(prisma: PrismaService, user: { walletEnabled?: boolean | null }) {
  const mode = await chainWalletMode(prisma);
  const enabled = mode === 'all' || (mode === 'per_user' && !!user.walletEnabled);
  return { enabled, url: enabled ? await chainWalletUrl(prisma) : '' };
}

export async function adminChainWalletConfig(prisma: PrismaService) {
  return { mode: await chainWalletMode(prisma), url: await chainWalletUrl(prisma) };
}

export async function adminSetChainWalletConfig(prisma: PrismaService, body: { mode?: unknown; url?: unknown }) {
  const put = (key: string, value: string) => prisma.sysSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  if (body?.mode !== undefined) {
    if (!(CHAIN_WALLET_MODES as readonly unknown[]).includes(body.mode)) throw new BadRequestException('mode 只能是 off / per_user / all');
    await put(KEY_CHAIN_WALLET_MODE, body.mode as string);
  }
  if (body?.url !== undefined) {
    const url = String(body.url).trim();
    if (url && !/^https:\/\/[\w.-]+(\/[\w./-]*)?$/.test(url)) throw new BadRequestException('钱包地址必须是 https 网址');
    await put(KEY_CHAIN_WALLET_URL, url);
  }
  return adminChainWalletConfig(prisma);
}
