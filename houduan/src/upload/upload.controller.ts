import { Controller, Post, UploadedFile, UseGuards, UseInterceptors, Param, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Throttle } from '../common/rate-limit.guard';
import { UploadService } from './upload.service';

@Controller('upload')
export class UploadController {
  constructor(private readonly uploads: UploadService) {}

  /** 注册头像上传：注册时还没有 token，免登录，仅图片、限 10MB、按 IP 限频 */
  @Post('avatar')
  @Throttle(15, 3600)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  avatar(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('缺少文件');
    return this.uploads.upload('image', file);
  }

  /** kind: image | video | audio，form-data 字段名 file */
  @Post(':kind')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 200 * 1024 * 1024 } }))
  upload(@Param('kind') kind: string, @UploadedFile() file?: Express.Multer.File) {
    if (kind !== 'image' && kind !== 'video' && kind !== 'audio') throw new BadRequestException('kind 非法');
    if (!file) throw new BadRequestException('缺少文件');
    return this.uploads.upload(kind, file);
  }
}
