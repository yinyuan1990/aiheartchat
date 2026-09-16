import { Module } from '@nestjs/common';
import { ModuleController } from './module.controller';
import { AuthModule } from '../auth/auth.module';
import { AppVersionController } from './app-version.controller';
import { AppVersionService } from './app-version.service';

@Module({
  imports: [AuthModule],
  controllers: [ModuleController, AppVersionController],
  providers: [AppVersionService],
  exports: [AppVersionService],
})
export class ModuleConfigModule {}
