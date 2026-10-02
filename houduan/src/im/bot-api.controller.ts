import { All, Controller, Get, Logger, Param, Req, Res, UploadedFiles, UseInterceptors } from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { GlobalLimit } from '../common/rate-limit.guard';
import { BotApiError, BotService } from './bot.service';

/**
 * Telegram Bot API 兼容入口：https://<域名>/api/bot<token>/<method>
 * 参数可以放 query、JSON、form、multipart（和 Telegram 一样），返回 {ok, result} / {ok:false, error_code, description}。
 * 现成的 TG 机器人库把 API 地址改成 https://<域名>/api/bot 就能用。
 */
@Controller()
@GlobalLimit(3000)
export class BotApiController {
  private readonly log = new Logger('BotApi');

  constructor(private readonly bots: BotService) {}

  @All('bot:token/:method')
  @UseInterceptors(AnyFilesInterceptor({ limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  async call(
    @Param('token') token: string,
    @Param('method') method: string,
    @Req() req: Request,
    @Res() res: Response,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    try {
      const ctx = await this.bots.auth(token);
      const params = { ...(req.query as Record<string, unknown>), ...(typeof req.body === 'object' && req.body ? req.body : {}) };
      const result = await this.bots.call(ctx, method, params, files?.[0]);
      res.status(200).json({ ok: true, result });
    } catch (e) {
      this.fail(res, e);
    }
  }

  /** getFile 返回的 file_path 下载地址：/api/file/bot<token>/<file_path> */
  @Get('file/bot:token/*')
  async file(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    try {
      await this.bots.auth(token);
      const path = String((req.params as Record<string, string>)[0] ?? '');
      if (!/^res\/[\w./-]+$/.test(path) || path.includes('..')) throw new BotApiError(404, 'Not Found');
      res.redirect(302, `/${path}`);
    } catch (e) {
      this.fail(res, e);
    }
  }

  private fail(res: Response, e: unknown) {
    if (e instanceof BotApiError) {
      res.status(e.code).json({ ok: false, error_code: e.code, description: e.message, ...(e.parameters ? { parameters: e.parameters } : {}) });
      return;
    }
    const status = (e as any)?.getStatus?.();
    if (status && status < 500) {
      res.status(400).json({ ok: false, error_code: 400, description: `Bad Request: ${(e as any).message}` });
      return;
    }
    this.log.error(e);
    res.status(500).json({ ok: false, error_code: 500, description: 'Internal Server Error' });
  }
}
