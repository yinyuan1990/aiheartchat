/** What the main wallet signs to control its AI 托管; the wallet builds the same text (web/src/lib/wallet/aibot.ts). */
export const authMessage = (user: string, ts: number) => `Arm AI 托管\n地址: ${user.toLowerCase()}\n时间: ${ts}`;
