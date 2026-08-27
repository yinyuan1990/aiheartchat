import { Global, Module } from '@nestjs/common';
import { IntimacyService } from './intimacy.service';

/** 全局模块：IM/通话/动态各处都要记分，免去逐个 import */
@Global()
@Module({
  providers: [IntimacyService],
  exports: [IntimacyService],
})
export class IntimacyModule {}
