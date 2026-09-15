import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** 前端展示的帖子（匿名：不含作者信息，只告诉本人 mine） */
export interface TreeholePostView {
  id: bigint;
  content: string;
  /// 0=用户投稿 1=后台录入
  source: number;
  viewCount: number;
  commentCount: number;
  /// 最近评论的几位头像（列表卡片评论条用）
  commenters: { avatar: string }[];
  mine: boolean;
  createdAt: Date;
}

const POST_MIN = 5;
const POST_MAX = 3000;
const COMMENT_MAX = 500;

/**
 * 私密树洞：匿名投稿 + 实名评论。
 * 帖子来源：用户投稿（source=0）/ 后台手动录入（source=1）；对外一律匿名，作者 id 不下发。
 */
@Injectable()
export class TreeholeService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- 用户端 ----------

  async list(viewerId: bigint, beforeId?: bigint) {
    const posts = await this.prisma.treeholePost.findMany({
      where: { status: 0, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 20,
    });
    return this.hydrate(viewerId, posts);
  }

  /** 我的投稿（用于自己删除） */
  async mine(userId: bigint, beforeId?: bigint) {
    const posts = await this.prisma.treeholePost.findMany({
      where: { authorId: userId, status: 0, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 20,
    });
    return this.hydrate(userId, posts);
  }

  async detail(viewerId: bigint, id: bigint) {
    const post = await this.prisma.treeholePost.findUnique({ where: { id } });
    if (!post || post.status !== 0) throw new NotFoundException('内容不存在');
    // 阅读数 +1（不阻塞返回）
    void this.prisma.treeholePost.update({ where: { id }, data: { viewCount: { increment: 1 } } }).catch(() => {});
    const [view] = await this.hydrate(viewerId, [post]);
    return { ...view, viewCount: view.viewCount + 1 };
  }

  async publish(userId: bigint, rawContent: string) {
    const content = (rawContent ?? '').trim();
    if (content.length < POST_MIN) throw new BadRequestException(`至少写 ${POST_MIN} 个字`);
    if (content.length > POST_MAX) throw new BadRequestException(`最多 ${POST_MAX} 字`);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!user) throw new ForbiddenException('账号异常');
    const post = await this.prisma.treeholePost.create({ data: { authorId: userId, source: 0, content } });
    return { id: post.id };
  }

  /** 作者删除自己的投稿（软删除） */
  async remove(userId: bigint, id: bigint) {
    const post = await this.prisma.treeholePost.findUnique({ where: { id } });
    if (!post || post.status !== 0) throw new NotFoundException('内容不存在');
    if (post.authorId !== userId) throw new ForbiddenException('只能删除自己的投稿');
    await this.prisma.treeholePost.update({ where: { id }, data: { status: 1 } });
    return { ok: true };
  }

  async comments(postId: bigint, beforeId?: bigint) {
    const list = await this.prisma.treeholeComment.findMany({
      where: { postId, status: 0, ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 50,
    });
    const userIds = new Set(list.map((c) => c.userId.toString()));
    const replyIds = list.map((c) => c.replyToId).filter((x): x is bigint => x != null);
    const replyComments = replyIds.length
      ? await this.prisma.treeholeComment.findMany({ where: { id: { in: replyIds } } })
      : [];
    replyComments.forEach((c) => userIds.add(c.userId.toString()));
    const replyMap = new Map(replyComments.map((c) => [c.id.toString(), c]));

    const users = await this.prisma.user.findMany({
      where: { id: { in: [...userIds].map(BigInt) } },
      select: { id: true, nickname: true, avatar: true },
    });
    const userMap = new Map(users.map((u) => [u.id.toString(), u]));

    // 按时间正序返回（旧→新），像群聊讨论
    return list.reverse().map((c) => {
      const replyTo = c.replyToId ? replyMap.get(c.replyToId.toString()) : null;
      return {
        id: c.id,
        user: userMap.get(c.userId.toString()) ?? { id: c.userId, nickname: '用户', avatar: '' },
        content: c.content,
        replyToId: c.replyToId,
        replyToNickname: replyTo ? userMap.get(replyTo.userId.toString())?.nickname ?? '' : '',
        createdAt: c.createdAt,
      };
    });
  }

  async addComment(userId: bigint, postId: bigint, rawContent: string, replyToId?: string) {
    const post = await this.prisma.treeholePost.findUnique({ where: { id: postId } });
    if (!post || post.status !== 0) throw new NotFoundException('内容不存在');
    const content = (rawContent ?? '').trim();
    if (!content) throw new BadRequestException('评论不能为空');
    if (content.length > COMMENT_MAX) throw new BadRequestException(`评论最多 ${COMMENT_MAX} 字`);

    let replyTo: bigint | null = null;
    if (replyToId) {
      const target = await this.prisma.treeholeComment.findUnique({ where: { id: BigInt(replyToId) } });
      if (!target || target.postId !== postId || target.status !== 0) throw new BadRequestException('回复的评论不存在');
      replyTo = target.id;
    }

    const [comment] = await this.prisma.$transaction([
      this.prisma.treeholeComment.create({ data: { postId, userId, content, replyToId: replyTo } }),
      this.prisma.treeholePost.update({ where: { id: postId }, data: { commentCount: { increment: 1 } } }),
    ]);
    return { id: comment.id };
  }

  /** 补齐展示字段：最近 3 位评论者头像、是否本人 */
  private async hydrate(viewerId: bigint, posts: any[]): Promise<TreeholePostView[]> {
    if (posts.length === 0) return [];
    const ids = posts.map((p) => p.id as bigint);
    // 每帖最近 30 条评论里取前 3 位不同用户的头像
    const recent = await this.prisma.treeholeComment.findMany({
      where: { postId: { in: ids }, status: 0 },
      orderBy: { id: 'desc' },
      take: 30 * Math.min(ids.length, 20),
      select: { postId: true, userId: true },
    });
    const byPost = new Map<string, bigint[]>();
    for (const c of recent) {
      const key = c.postId.toString();
      const arr = byPost.get(key) ?? [];
      if (arr.length < 3 && !arr.some((u) => u === c.userId)) arr.push(c.userId);
      byPost.set(key, arr);
    }
    const userIds = [...new Set([...byPost.values()].flat().map((u) => u.toString()))].map(BigInt);
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, avatar: true } })
      : [];
    const avatarMap = new Map(users.map((u) => [u.id.toString(), u.avatar]));

    return posts.map((p) => ({
      id: p.id,
      content: p.content,
      source: p.source,
      viewCount: p.viewCount,
      commentCount: p.commentCount,
      commenters: (byPost.get(p.id.toString()) ?? []).map((u) => ({ avatar: avatarMap.get(u.toString()) ?? '' })),
      mine: p.authorId != null && p.authorId === viewerId,
      createdAt: p.createdAt,
    }));
  }

  // ---------- 后台 ----------

  /** 后台列表：含隐藏；status 可筛选 */
  async adminList(beforeId?: bigint, status?: number) {
    const posts = await this.prisma.treeholePost.findMany({
      where: { ...(status != null ? { status } : {}), ...(beforeId ? { id: { lt: beforeId } } : {}) },
      orderBy: { id: 'desc' },
      take: 50,
    });
    const authorIds = [...new Set(posts.map((p) => p.authorId).filter((x): x is bigint => x != null).map(String))].map(BigInt);
    const authors = authorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, nickname: true, shortId: true } })
      : [];
    const authorMap = new Map(authors.map((a) => [a.id.toString(), a]));
    return posts.map((p) => ({
      ...p,
      author: p.authorId ? authorMap.get(p.authorId.toString()) ?? null : null,
    }));
  }

  /** 后台手动录入（匿名，source=1） */
  async adminCreate(rawContent: string) {
    const content = (rawContent ?? '').trim();
    if (!content) throw new BadRequestException('内容不能为空');
    if (content.length > POST_MAX) throw new BadRequestException(`最多 ${POST_MAX} 字`);
    return this.prisma.treeholePost.create({ data: { authorId: null, source: 1, content } });
  }

  /** 后台编辑内容（仅后台录入的帖子） */
  async adminUpdate(id: bigint, rawContent: string) {
    const content = (rawContent ?? '').trim();
    if (!content) throw new BadRequestException('内容不能为空');
    const post = await this.prisma.treeholePost.findUnique({ where: { id } });
    if (!post) throw new NotFoundException('内容不存在');
    if (post.source !== 1) throw new BadRequestException('用户投稿不可编辑，只能隐藏');
    return this.prisma.treeholePost.update({ where: { id }, data: { content } });
  }

  async adminSetStatus(id: bigint, status: number) {
    if (status !== 0 && status !== 1) throw new BadRequestException('状态非法');
    return this.prisma.treeholePost.update({ where: { id }, data: { status } });
  }

  /** 后台看某帖全部评论（含已删） */
  async adminComments(postId: bigint) {
    const list = await this.prisma.treeholeComment.findMany({ where: { postId }, orderBy: { id: 'asc' } });
    const userIds = [...new Set(list.map((c) => c.userId.toString()))].map(BigInt);
    const users = userIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, nickname: true, shortId: true, avatar: true } })
      : [];
    const userMap = new Map(users.map((u) => [u.id.toString(), u]));
    return list.map((c) => ({ ...c, user: userMap.get(c.userId.toString()) ?? null }));
  }

  async adminDeleteComment(id: bigint) {
    const c = await this.prisma.treeholeComment.findUnique({ where: { id } });
    if (!c) throw new NotFoundException('评论不存在');
    if (c.status === 1) return c;
    const [updated] = await this.prisma.$transaction([
      this.prisma.treeholeComment.update({ where: { id }, data: { status: 1 } }),
      this.prisma.treeholePost.update({ where: { id: c.postId }, data: { commentCount: { decrement: 1 } } }),
    ]);
    return updated;
  }
}
