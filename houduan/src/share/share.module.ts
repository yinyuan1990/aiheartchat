import { Module } from '@nestjs/common';
import { MusicModule } from '../music/music.module';
import { GalleryModule } from '../gallery/gallery.module';
import { TreeholeModule } from '../treehole/treehole.module';
import { ShareController } from './share.controller';

/** 分享落地页（服务端出带 og 标签的 HTML，供链接卡片抓图） */
@Module({
  imports: [MusicModule, GalleryModule, TreeholeModule],
  controllers: [ShareController],
})
export class ShareModule {}
