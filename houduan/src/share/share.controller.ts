import { Controller, Get, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '../common/rate-limit.guard';
import { MusicService } from '../music/music.service';
import { GalleryService } from '../gallery/gallery.service';

/** 分享链接域名（微信 / QQ / Telegram 的链接卡片抓这个页面的 og 标签） */
const APP_BASE = (process.env.PUBLIC_APP_BASE || 'https://app.yyheart.com').replace(/\/$/, '');
const APP_NAME = '心之音';

interface OgPage {
  title: string;
  desc: string;
  image: string;
  /** 浏览器打开时跳到的 H5 路由（hash 路由） */
  target: string;
  type?: 'music.song' | 'article' | 'website';
}

/**
 * 分享落地页（服务端出 HTML）：
 * H5 是 hash 路由的单页应用，链接卡片抓取器（微信 / QQ / Telegram / iMessage）拿不到标题和图片；
 * 这里返回带 og:title / og:description / og:image 的极简 HTML，普通浏览器立刻跳到真正的 H5 页面。
 * nginx：app.yyheart.com/s/ → /api/share/，分享出去的是 https://app.yyheart.com/s/music/:id 这种短地址。
 */
@Controller('share')
export class ShareController {
  constructor(private readonly music: MusicService, private readonly gallery: GalleryService) {}

  @Get('music/:id')
  @Throttle(60, 60)
  async music_(@Param('id') id: string, @Res() res: Response) {
    let page: OgPage;
    try {
      const t = await this.music.publicTrack(BigInt(id));
      const sub = [t.performer, t.source?.title].filter(Boolean).join(' · ');
      page = { title: t.title, desc: sub ? `${sub} · 点开就能听 · ${APP_NAME}` : `点开就能听 · ${APP_NAME}`, image: t.fullCover, target: `/#/music/share/${t.id}`, type: 'music.song' };
    } catch {
      page = { title: `${APP_NAME} · 音乐`, desc: '这首歌已下架', image: '', target: `/#/music/share/${id}` };
    }
    this.send(res, page);
  }

  @Get('gallery/:id')
  @Throttle(60, 60)
  async gallery_(@Param('id') id: string, @Res() res: Response) {
    let page: OgPage;
    try {
      const p = await this.gallery.publicPost(BigInt(id));
      const imgs = p.media.filter((m) => m.type === 'image').length;
      const vids = p.media.length - imgs;
      const count = [imgs ? `${imgs} 张图片` : '', vids ? `${vids} 个视频` : ''].filter(Boolean).join(' · ');
      const first = p.media[0];
      const image = first ? (first.type === 'video' ? first.cover || '' : first.url) : '';
      page = { title: p.title || `${APP_NAME} · 养眼图片`, desc: (p.text || count || APP_NAME).slice(0, 80), image, target: `/#/gallery/share/${p.id}`, type: 'article' };
    } catch {
      page = { title: `${APP_NAME} · 养眼图片`, desc: '这条内容已过期', image: '', target: `/#/gallery/share/${id}` };
    }
    this.send(res, page);
  }

  private send(res: Response, p: OgPage) {
    const url = APP_BASE + p.target;
    const t = esc(p.title);
    const d = esc(p.desc);
    const img = p.image ? `<meta property="og:image" content="${esc(p.image)}"><meta name="twitter:image" content="${esc(p.image)}"><meta itemprop="image" content="${esc(p.image)}">` : '';
    // 微信内置浏览器抓卡片会取页面里第一张 <img>，og:image 之外再放一张不可见的
    const imgTag = p.image ? `<img src="${esc(p.image)}" alt="" style="position:absolute;width:1px;height:1px;opacity:0">` : '';
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<meta property="og:type" content="${p.type ?? 'website'}"><meta property="og:site_name" content="${APP_NAME}">
<meta property="og:title" content="${t}"><meta property="og:description" content="${d}"><meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="${p.image ? 'summary_large_image' : 'summary'}"><meta name="twitter:title" content="${t}"><meta name="twitter:description" content="${d}">
<meta itemprop="name" content="${t}"><meta itemprop="description" content="${d}">${img}
<meta http-equiv="refresh" content="0;url=${esc(url)}">
<script>location.replace(${JSON.stringify(url)})</script>
<style>body{margin:0;font:15px -apple-system,system-ui,sans-serif;color:#8e8e93;display:flex;align-items:center;justify-content:center;height:100vh;background:#fff}</style>
</head><body>${imgTag}<a href="${esc(url)}" style="color:#8e8e93;text-decoration:none">正在打开 ${t}…</a></body></html>`;
    res.status(200).setHeader('Cache-Control', 'public, max-age=300').type('html').send(html);
  }
}

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
