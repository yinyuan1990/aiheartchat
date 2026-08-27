import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from './common/rate-limit.guard';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { ModuleConfigModule } from './module/module.module';
import { ImModule } from './im/im.module';
import { UploadModule } from './upload/upload.module';
import { CallModule } from './call/call.module';
import { WalletModule } from './wallet/wallet.module';
import { GiftModule } from './gift/gift.module';
import { MomentModule } from './moment/moment.module';
import { TaskModule } from './task/task.module';
import { GuideModule } from './guide/guide.module';
import { AdminModule } from './admin/admin.module';
import { NotifyModule } from './notify/notify.module';
import { IntimacyModule } from './intimacy/intimacy.module';
import { AiModule } from './ai/ai.module';
import { NewsModule } from './news/news.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    AuthModule,
    UserModule,
    ModuleConfigModule,
    ImModule,
    UploadModule,
    CallModule,
    WalletModule,
    GiftModule,
    MomentModule,
    TaskModule,
    GuideModule,
    AdminModule,
    NotifyModule,
    IntimacyModule,
    AiModule,
    NewsModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }],
})
export class AppModule {}
