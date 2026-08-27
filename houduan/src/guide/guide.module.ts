import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GuideController } from './guide.controller';
import { GuideService } from './guide.service';

@Module({
  imports: [AuthModule],
  controllers: [GuideController],
  providers: [GuideService],
})
export class GuideModule {}
