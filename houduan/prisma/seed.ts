import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  // 通话参数默认值（后台可调）
  const cfg = await prisma.callConfig.findFirst();
  if (!cfg) {
    await prisma.callConfig.create({ data: { width: 640, height: 480, fps: 25, bitrate: 800 } });
  } else if (cfg.fps === 30) {
    await prisma.callConfig.update({ where: { id: cfg.id }, data: { fps: 25 } });
  }

  // 计费配置：消息 0.1 积分/条；视频成本价 2 分/分钟（640x480@800kbps 双向流量费），平台倍率 x2
  const price = await prisma.priceConfig.findFirst();
  if (!price) {
    await prisma.priceConfig.create({ data: { msgPriceFen: 10, videoBaseFenPerMin: 2, videoPlatformX: 2 } });
  } else if (price.videoBaseFenPerMin === 300) {
    // 旧默认价（300 分 = 平台成本价体系）→ 新的流量成本价体系
    await prisma.priceConfig.update({ where: { id: price.id }, data: { videoBaseFenPerMin: 2, videoPlatformX: 2 } });
  }

  // 默认礼物（抖音风格图标，幂等 upsert；不在列表中的旧礼物自动下架）
  // 价格单位：分（100 分 = 1 积分 = 1 元）
  const gifts: [string, string, bigint][] = [
    ['小心心', '/static/gift/xiaoxinxin.png', 100n],
    ['玫瑰', '/static/gift/meigui.png', 200n],
    ['大啤酒', '/static/gift/dapijiu.png', 500n],
    ['口红', '/static/gift/kouhong.png', 600n],
    ['棒棒糖', '/static/gift/bangbangtang.png', 900n],
    ['甜甜圈', '/static/gift/tiantianquan.png', 5200n],
    ['亲吻', '/static/gift/qinwen.png', 9900n],
    ['比心', '/static/gift/bixin.png', 19900n],
    ['真爱玫瑰', '/static/gift/zhenaimeigui.png', 36600n],
    ['真的爱你', '/static/gift/zhendeaini.png', 52000n],
    ['万象烟花', '/static/gift/yanhua.png', 68800n],
    ['保时捷', '/static/gift/baoshijie.png', 128800n],
    ['公主马车', '/static/gift/mache.png', 131400n],
    ['直升机', '/static/gift/zhishengji.png', 299900n],
    ['超级跑车', '/static/gift/paoche.png', 334400n],
    ['游艇派对', '/static/gift/youting.png', 888800n],
    ['梦幻城堡', '/static/gift/chengbao.png', 1314000n],
    ['嘉年华', '/static/gift/jianianhua.png', 1999900n],
  ];
  for (let i = 0; i < gifts.length; i++) {
    const [name, icon, price] = gifts[i];
    const existing = await prisma.gift.findFirst({ where: { name } });
    if (existing) {
      await prisma.gift.update({ where: { id: existing.id }, data: { icon, price, sort: i + 1, enabled: true } });
    } else {
      await prisma.gift.create({ data: { name, icon, price, sort: i + 1 } });
    }
  }
  await prisma.gift.updateMany({
    where: { name: { notIn: gifts.map(([n]) => n) } },
    data: { enabled: false },
  });

  // 项目大厅：每个项目一张横幅卡。地陪是项目一；游戏等新项目后台加卡即上线（visibleGender=0）
  await prisma.appModule.deleteMany({ where: { entry: { in: ['task_post', 'task_hall'] } } });
  const guideProject = await prisma.appModule.findFirst({ where: { entry: 'guide' } });
  const guideData = {
    name: '同城搭子',
    desc: '逛街看展 · 同城活动 · 找个搭子一起玩',
    cover: '',
    type: 'native',
    entry: 'guide',
    sort: 1,
    enabled: true,
    visibleGender: 0,
  };
  if (guideProject) {
    await prisma.appModule.update({ where: { id: guideProject.id }, data: guideData });
  } else {
    await prisma.appModule.create({ data: guideData });
  }

  // 管理员账号 admin / 初始密码 peiwan@2026（scrypt 哈希）
  const admin = await prisma.adminUser.findUnique({ where: { username: 'admin' } });
  if (!admin) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync('peiwan@2026', salt, 32).toString('hex');
    await prisma.adminUser.create({ data: { username: 'admin', passwordHash: `${salt}:${hash}` } });
  }

  // 给历史用户补 6 位短号
  const noShortId = await prisma.user.findMany({ where: { shortId: null }, select: { id: true } });
  for (const u of noShortId) {
    let sid = '';
    for (let i = 0; i < 20; i++) {
      const candidate = String(Math.floor(100000 + Math.random() * 900000));
      if (!(await prisma.user.findUnique({ where: { shortId: candidate } }))) {
        sid = candidate;
        break;
      }
    }
    if (sid) await prisma.user.update({ where: { id: u.id }, data: { shortId: sid } });
  }

  console.log('seed done');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
