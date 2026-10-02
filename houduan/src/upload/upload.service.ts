import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as Minio from 'minio';

const ALLOWED: Record<string, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  video: ['video/mp4', 'video/quicktime'],
  audio: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/m4a', 'audio/x-m4a', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/3gpp', 'application/octet-stream'],
};

@Injectable()
export class UploadService implements OnModuleInit {
  private readonly logger = new Logger('Upload');
  private readonly client: Minio.Client;
  private readonly bucket: string;

  constructor(config: ConfigService) {
    this.bucket = config.get<string>('MINIO_BUCKET') ?? 'peiwan';
    this.client = new Minio.Client({
      endPoint: config.get<string>('MINIO_ENDPOINT') ?? '127.0.0.1',
      port: Number(config.get('MINIO_PORT') ?? 9000),
      useSSL: false,
      accessKey: config.get<string>('MINIO_ACCESS_KEY') ?? '',
      secretKey: config.get<string>('MINIO_SECRET_KEY') ?? '',
    });
  }

  async onModuleInit() {
    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        await this.client.makeBucket(this.bucket);
      }
      // 公共读：媒体通过 nginx /res/ 路径访问
      const policy = {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${this.bucket}/*`],
          },
        ],
      };
      await this.client.setBucketPolicy(this.bucket, JSON.stringify(policy));
    } catch (e) {
      this.logger.warn(`MinIO 初始化失败（本地无 MinIO 时可忽略）: ${e}`);
    }
  }

  /** 上传文件，返回可经 nginx /res/ 访问的相对路径 */
  async upload(kind: 'image' | 'video' | 'audio', file: { buffer: Buffer; mimetype: string; size: number }) {
    const allowed = ALLOWED[kind];
    if (!allowed?.includes(file.mimetype)) throw new BadRequestException('不支持的文件类型');
    const maxSize = kind === 'image' ? 20 * 1024 * 1024 : kind === 'audio' ? 10 * 1024 * 1024 : 200 * 1024 * 1024;
    if (file.size > maxSize) throw new BadRequestException('文件过大');

    const ext = file.mimetype.split('/')[1].replace('quicktime', 'mov').replace('x-m4a', 'm4a').replace('mpeg', kind === 'audio' ? 'mp3' : 'mpeg').replace('octet-stream', 'm4a');
    const object = `${kind}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;
    await this.client.putObject(this.bucket, object, file.buffer, file.size, {
      'Content-Type': file.mimetype,
    });
    return { url: `/res/${this.bucket}/${object}` };
  }

  /**
   * 服务端内部转存（不走用户上传的类型/大小限制）：如 Telegram 频道同步下来的音乐文件（100MB+）。
   * prefix 为对象前缀目录（如 music），ext 为扩展名（不带点）。
   */
  async putInternal(prefix: string, ext: string, buffer: Buffer, mimetype: string, extraMeta: Record<string, string> = {}) {
    const clean = (ext || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    const object = `${prefix}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${clean}`;
    await this.client.putObject(this.bucket, object, buffer, buffer.length, { 'Content-Type': mimetype, ...extraMeta });
    return { url: `/res/${this.bucket}/${object}` };
  }

  /**
   * 同上，但从本地文件流式上传（MinIO fPutObject），文件不进 Node 堆：
   * 音乐同步一首 100MB+ 的曲子若整个读成 Buffer，再加 GramJS 下载时的分块副本，api 容器（512MB 上限）会被 OOM 杀掉。
   */
  async putInternalFile(prefix: string, ext: string, filePath: string, mimetype: string, extraMeta: Record<string, string> = {}) {
    const clean = (ext || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
    const object = `${prefix}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${clean}`;
    await this.client.fPutObject(this.bucket, object, filePath, { 'Content-Type': mimetype, ...extraMeta });
    return { url: `/res/${this.bucket}/${object}` };
  }

  /**
   * 服务端复制一份用户上传的媒体（image/ video/ audio/ 目录），返回新地址；其它地址原样返回。
   * 转发消息时用：频道消息会被定时物理删除，转发出去 / 转发进来的那份不能跟着失效。
   */
  async copy(url: string) {
    const prefix = `/res/${this.bucket}/`;
    const i = url.indexOf(prefix);
    if (i < 0) return url;
    const src = url.slice(i + prefix.length).split(/[?#]/)[0];
    const m = /^(image|video|audio)\/[\w./-]+?\.(\w{1,8})$/.exec(src);
    if (!m) return url;
    const object = `${m[1]}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${m[2]}`;
    try {
      await this.client.copyObject(this.bucket, object, `/${this.bucket}/${src}`);
    } catch (e: any) {
      this.logger.warn(`copy ${src}: ${e?.message ?? e}`);
      return url;
    }
    return `${url.slice(0, i)}${prefix}${object}`;
  }

  /** 删除站内资源（只认本 bucket 的 /res/<bucket>/ 路径，其它忽略） */
  async remove(url: string) {
    const prefix = `/res/${this.bucket}/`;
    if (!url?.startsWith(prefix)) return;
    await this.client.removeObject(this.bucket, url.slice(prefix.length).split(/[?#]/)[0]).catch((e) => this.logger.warn(`remove ${url}: ${e?.message}`));
  }

  /**
   * 后台上传 apk：校验 zip 魔数（apk 就是 zip），按时间戳命名避免 CDN/浏览器缓存旧包，
   * 返回完整下载地址（PUBLIC_RES_BASE，默认 https://api.yyheart.com）供「App 版本」页直接保存。
   */
  async uploadApk(file: { buffer: Buffer; mimetype: string; size: number; originalname?: string }) {
    const b = file.buffer;
    const isZip = b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);
    if (!isZip || !/\.apk$/i.test(file.originalname ?? '.apk')) throw new BadRequestException('请上传 .apk 安装包');
    if (file.size > 200 * 1024 * 1024) throw new BadRequestException('安装包超过 200MB');

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const object = `apk/peiwan-${stamp}.apk`;
    await this.client.putObject(this.bucket, object, b, file.size, {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="peiwan.apk"',
    });
    const base = (process.env.PUBLIC_RES_BASE || 'https://api.yyheart.com').replace(/\/$/, '');
    return { url: `${base}/res/${this.bucket}/${object}`, size: file.size, object };
  }
}
