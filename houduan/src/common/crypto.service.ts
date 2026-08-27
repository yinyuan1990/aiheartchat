import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * 消息加密：每个会话一把 AES-256-GCM 密钥；
 * 会话密钥再用服务端主密钥（MASTER_KEY）AES-256-GCM 包裹后落库，库内无明文。
 * 密文格式统一为 base64(iv):base64(tag):base64(cipher)
 */
@Injectable()
export class CryptoService {
  private readonly masterKey: Buffer;

  constructor(config: ConfigService) {
    const hex = config.get<string>('MASTER_KEY');
    if (!hex || hex.length !== 64) {
      throw new Error('MASTER_KEY 必须是 64 位 hex（32 字节）');
    }
    this.masterKey = Buffer.from(hex, 'hex');
  }

  generateConversationKey(): Buffer {
    return crypto.randomBytes(32);
  }

  wrapKey(key: Buffer): string {
    return this.encryptWith(this.masterKey, key.toString('base64'));
  }

  unwrapKey(wrapped: string): Buffer {
    return Buffer.from(this.decryptWith(this.masterKey, wrapped), 'base64');
  }

  encrypt(convKey: Buffer, plaintext: string): string {
    return this.encryptWith(convKey, plaintext);
  }

  decrypt(convKey: Buffer, ciphertext: string): string {
    return this.decryptWith(convKey, ciphertext);
  }

  private encryptWith(key: Buffer, plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  }

  private decryptWith(key: Buffer, payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }
}
