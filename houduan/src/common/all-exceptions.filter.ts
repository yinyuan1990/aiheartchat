import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { langOf, translate } from '../i18n/translate';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let msg = '服务器内部错误';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        msg = body;
      } else if (typeof body === 'object' && body !== null) {
        const m = (body as any).message;
        msg = Array.isArray(m) ? m[0] : m || msg;
      }
    } else {
      this.logger.error(exception);
    }

    res.status(status >= 500 ? 500 : 200).json({ code: status, msg: translate(msg, langOf(req?.headers?.['accept-language'])), data: null });
  }
}
