import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CryptoService } from '../common/crypto.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ReviewService } from './review.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '30d' },
      }),
      global: true,
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, CryptoService, JwtAuthGuard, ReviewService],
  exports: [AuthService, CryptoService, JwtAuthGuard, ReviewService],
})
export class AuthModule {}
