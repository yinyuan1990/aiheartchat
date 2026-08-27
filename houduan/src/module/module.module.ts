import { Module } from '@nestjs/common';
import { ModuleController } from './module.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [ModuleController],
})
export class ModuleConfigModule {}
