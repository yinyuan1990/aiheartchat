import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { langOf, localizeData } from '../i18n/translate';

/** 统一返回结构 {code, msg, data}；非中文请求把后台配置的中文（礼物名、大厅卡片）换成对应语言 */
@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const lang = ctx.getType() === 'http' ? langOf(ctx.switchToHttp().getRequest()?.headers?.['accept-language']) : null;
    return next.handle().pipe(map((data) => ({ code: 0, msg: 'ok', data: localizeData(data ?? null, lang) })));
  }
}
