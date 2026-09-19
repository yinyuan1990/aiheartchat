import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { LogLevel, Logger as TgLogger } from 'telegram/extensions/Logger';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Telegram 用户账号客户端（MTProto，GramJS）。
 *
 * 用途：读取公开频道里的音频文件（网页预览 t.me/s 不给文件，且音乐类频道多数关闭了预览）。
 * 全服务只有一个客户端；登录态（StringSession）存 sys_setting.tg_session，重启自动恢复。
 * 登录流程由管理后台驱动：填 api_id/api_hash（my.telegram.org 申请）→ 手机号发码 → 输码（+ 两步验证密码）。
 *
 * api_id / api_hash 优先级：sys_setting → 环境变量 TG_API_ID/TG_API_HASH → 内置 Telegram Desktop 公共值（能用，但建议自己申请）。
 */
@Injectable()
export class TelegramClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Telegram');
  private client?: TelegramClient;
  private connecting?: Promise<TelegramClient>;
  /** 发码后等待输码的上下文 */
  private pending?: { phone: string; phoneCodeHash: string; at: number };

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // 有登录态就提前连上，音乐同步第一次跑不用等握手
    setTimeout(() => void this.getClient().catch((e) => this.logger.warn(`启动连接失败: ${e?.message ?? e}`)), 5_000);
  }

  async onModuleDestroy() {
    await this.client?.disconnect().catch(() => {});
  }

  // ---------- 配置 ----------

  private async setting(key: string): Promise<string> {
    const row = await this.prisma.sysSetting.findUnique({ where: { key } });
    return row?.value ?? '';
  }

  private async setSetting(key: string, value: string) {
    await this.prisma.sysSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  private async creds(): Promise<{ apiId: number; apiHash: string; custom: boolean }> {
    const id = (await this.setting('tg_api_id')) || process.env.TG_API_ID || '';
    const hash = (await this.setting('tg_api_hash')) || process.env.TG_API_HASH || '';
    if (id && hash) return { apiId: Number(id), apiHash: hash, custom: true };
    // Telegram Desktop 公开的开发凭据（官方源码里的值）
    return { apiId: 2040, apiHash: 'b18441a1ff607e10a989891a5462e627', custom: false };
  }

  /** 后台保存 api_id / api_hash（清空则回退到内置值）；保存后断开重连 */
  async saveApi(apiId: string, apiHash: string) {
    const id = String(apiId ?? '').trim();
    const hash = String(apiHash ?? '').trim();
    if ((id && !/^\d+$/.test(id)) || (hash && !/^[0-9a-f]{32}$/i.test(hash))) throw new BadRequestException('api_id 应为数字，api_hash 为 32 位十六进制');
    if (!!id !== !!hash) throw new BadRequestException('api_id 与 api_hash 需要同时填写或同时清空');
    await this.setSetting('tg_api_id', id);
    await this.setSetting('tg_api_hash', hash);
    await this.reset();
    return this.status();
  }

  // ---------- 连接 ----------

  private async reset() {
    const c = this.client;
    this.client = undefined;
    this.connecting = undefined;
    this.pending = undefined;
    await c?.disconnect().catch(() => {});
  }

  /** 拿到已连接的客户端（可能未登录）。并发调用共用同一次握手 */
  async getClient(): Promise<TelegramClient> {
    if (this.client?.connected) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const { apiId, apiHash } = await this.creds();
      const session = await this.setting('tg_session');
      const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
        connectionRetries: 5,
        autoReconnect: true,
        floodSleepThreshold: 60,
        // 大文件分块并行下载：默认 1 路只有 ~0.4MB/s，100MB 一首要 4 分钟
        maxConcurrentDownloads: 8,
        deviceModel: 'yyheart-server',
        systemVersion: 'Linux',
        appVersion: '1.0',
        langCode: 'zh',
        baseLogger: new TgLogger(LogLevel.ERROR),
      });
      await client.connect();
      this.client = client;
      return client;
    })();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  /** 已登录的客户端；未登录抛错（给同步任务用） */
  async authorized(): Promise<TelegramClient> {
    const client = await this.getClient();
    if (!(await client.isUserAuthorized().catch(() => false))) throw new Error('Telegram 账号未登录，请到后台「音乐频道」登录');
    return client;
  }

  async isLoggedIn(): Promise<boolean> {
    try {
      const client = await this.getClient();
      return await client.isUserAuthorized();
    } catch {
      return false;
    }
  }

  // ---------- 登录流程（后台） ----------

  async status() {
    const { apiId, custom } = await this.creds();
    let loggedIn = false;
    let user: { id: string; firstName: string; username: string; phone: string } | null = null;
    let error = '';
    try {
      const client = await this.getClient();
      loggedIn = await client.isUserAuthorized();
      if (loggedIn) {
        const me = await client.getMe();
        if (me instanceof Api.User) {
          user = { id: me.id.toString(), firstName: [me.firstName, me.lastName].filter(Boolean).join(' '), username: me.username ?? '', phone: me.phone ?? '' };
        }
      }
    } catch (e: any) {
      error = String(e?.message ?? e).slice(0, 200);
    }
    return {
      apiId,
      customApi: custom,
      loggedIn,
      user,
      pendingPhone: this.pending && Date.now() - this.pending.at < 10 * 60_000 ? this.pending.phone : '',
      error,
    };
  }

  /** 第一步：给手机号发验证码（Telegram 已登录设备优先收到 App 内消息，否则短信） */
  async sendCode(phoneRaw: string) {
    const phone = String(phoneRaw ?? '').replace(/[\s-]/g, '');
    if (!/^\+?\d{6,15}$/.test(phone)) throw new BadRequestException('请填写带国家码的手机号，如 +8613800000000');
    const { apiId, apiHash } = await this.creds();
    const client = await this.getClient();
    if (await client.isUserAuthorized()) throw new BadRequestException('已经登录，先退出再换号');
    try {
      const r = await client.sendCode({ apiId, apiHash }, phone.startsWith('+') ? phone : `+${phone}`);
      this.pending = { phone: phone.startsWith('+') ? phone : `+${phone}`, phoneCodeHash: r.phoneCodeHash, at: Date.now() };
      return { sent: true, viaApp: r.isCodeViaApp };
    } catch (e: any) {
      throw new BadRequestException(this.humanError(e));
    }
  }

  /** 第二步：输验证码；开了两步验证的号还要 password */
  async signIn(codeRaw: string, password?: string) {
    const code = String(codeRaw ?? '').replace(/\D/g, '');
    if (!this.pending) throw new BadRequestException('请先发送验证码');
    if (!code && !password) throw new BadRequestException('请输入验证码');
    const { apiId, apiHash } = await this.creds();
    const client = await this.getClient();
    const { phone, phoneCodeHash } = this.pending;
    try {
      if (code) {
        const r = await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
        if (r instanceof Api.auth.AuthorizationSignUpRequired) throw new BadRequestException('该手机号没有注册 Telegram');
      }
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      const msg = String(e?.errorMessage ?? e?.message ?? '');
      if (msg.includes('SESSION_PASSWORD_NEEDED')) {
        if (!password) return { needPassword: true };
      } else {
        throw new BadRequestException(this.humanError(e));
      }
    }
    if (password && !(await client.isUserAuthorized())) {
      try {
        await client.signInWithPassword({ apiId, apiHash }, {
          password: async () => password,
          onError: async (err) => { throw err; },
        });
      } catch (e: any) {
        throw new BadRequestException(this.humanError(e));
      }
    }
    if (!(await client.isUserAuthorized())) throw new BadRequestException('登录未完成，请重试');
    const session = (client.session as StringSession).save();
    await this.setSetting('tg_session', session);
    this.pending = undefined;
    this.logger.log('Telegram 账号已登录');
    return { ok: true, ...(await this.status()) };
  }

  async logout() {
    try {
      const client = await this.getClient();
      if (await client.isUserAuthorized()) await client.invoke(new Api.auth.LogOut());
    } catch (e: any) {
      this.logger.warn(`logout: ${e?.message ?? e}`);
    }
    await this.setSetting('tg_session', '');
    await this.reset();
    return this.status();
  }

  // ---------- 频道 ----------

  /** 解析公开频道：标题 / 订阅数 / 简介；不是频道或不存在抛错 */
  async resolveChannel(username: string) {
    const client = await this.authorized();
    let entity: Api.TypeEntityLike;
    try {
      entity = await client.getEntity(username);
    } catch (e: any) {
      throw new BadRequestException(`找不到频道 @${username}：${this.humanError(e)}`);
    }
    if (!(entity instanceof Api.Channel) || entity.megagroup) throw new BadRequestException(`@${username} 不是频道（可能是群组或个人账号）`);
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
    const fc = full.fullChat as Api.ChannelFull;
    return {
      entity,
      title: entity.title,
      username: entity.username ?? username,
      subscribers: fc.participantsCount ?? 0,
      about: fc.about ?? '',
    };
  }

  private humanError(e: any): string {
    const raw = String(e?.errorMessage ?? e?.message ?? e);
    const map: [RegExp, string][] = [
      [/PHONE_NUMBER_INVALID/, '手机号格式不对（要带国家码）'],
      [/PHONE_NUMBER_BANNED/, '该手机号已被 Telegram 封禁'],
      [/PHONE_NUMBER_UNOCCUPIED/, '该手机号没有注册 Telegram'],
      [/PHONE_CODE_INVALID/, '验证码错误'],
      [/PHONE_CODE_EXPIRED/, '验证码已过期，请重新发送'],
      [/PASSWORD_HASH_INVALID/, '两步验证密码错误'],
      [/FLOOD_WAIT_(\d+)/, '操作太频繁，Telegram 要求稍后再试'],
      [/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/, 'api_id / api_hash 无效或被限流，请到 my.telegram.org 申请自己的'],
      [/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED/, '登录态已失效，请重新登录'],
      [/USERNAME_NOT_OCCUPIED|USERNAME_INVALID/, '频道用户名不存在'],
      [/CHANNEL_PRIVATE/, '频道是私有的或已被限制'],
    ];
    for (const [re, text] of map) {
      const m = raw.match(re);
      if (m) return m[1] ? `${text}（${m[1]} 秒）` : text;
    }
    return raw.slice(0, 200);
  }
}
