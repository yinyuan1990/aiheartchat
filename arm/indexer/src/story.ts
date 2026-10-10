import { randomBytes } from "node:crypto";
import { sql } from "./db.js";
import { ENTRY, me, rateNow, walletOf } from "./boat.js";

/**
 * 防捞女剧情游戏「清醒局」(10.10, web /love). Chat-style story levels adapted from public reports, people renamed.
 * Each step ends in a choice; a wrong one costs one of 3 hearts, the level is cleared with a heart left.
 * $BOAT (boat.ts ledger): until a wallet clears a level, each try costs ENTRY (bonus first); clearing pays
 * STORY_REWARD × pool rate once per wallet per level; replays after that are free and unpaid.
 * The script lives here only: the page fetches it from /api/story/levels and the server re-scores the choices.
 */

type T = { zh: string; en: string };
type Line = { who: "her" | "me" | "nar" | "net"; t: T; at?: T };
type Choice = { t: T; ok: boolean; why: T };
type Step = { lines: Line[]; ask: T; choices: Choice[]; real: T };
type Level = {
  id: number;
  title: T;
  tagline: T;
  basedOn: T;
  me: T;
  her: T;
  steps: Step[];
  lesson: T;
  recap: T[];
  sources: { name: string; url: string }[];
};

export const STORY_REWARD = 1000;
const HEARTS = 3;
/** reading a level takes a while; faster than this is a script, not a player */
const MIN_SECS = 25;

const her = (zh: string, en: string): Line => ({ who: "her", t: { zh, en } });
const mine = (zh: string, en: string): Line => ({ who: "me", t: { zh, en } });
const nar = (zh: string, en: string, at?: T): Line => ({ who: "nar", t: { zh, en }, at });
const net = (zh: string, en: string): Line => ({ who: "net", t: { zh, en } });
const c = (ok: boolean, zh: string, en: string, whyZh: string, whyEn: string): Choice => ({ ok, t: { zh, en }, why: { zh: whyZh, en: whyEn } });
const tx = (zh: string, en: string): T => ({ zh, en });

const LEVELS: Level[] = [
  {
    id: 1,
    title: tx("第一关 · 79.9 万", "Level 1 · ¥799,000"),
    tagline: tx("真心也要有边界", "Even true love needs limits"),
    basedOn: tx("改编自 2024 年「胖猫事件」", "Adapted from the 2024 \"Fat Cat\" case"),
    me: tx("阿凯", "Kai"),
    her: tx("小雨", "Rain"),
    steps: [
      {
        lines: [
          nar("你叫阿凯，21 岁，在湖南小城接单代练游戏。打游戏认识的重庆女孩小雨，成了你的女朋友。", "You're Kai, 21, coaching game accounts for cash in a small town in Hunan. Rain, a girl from Chongqing you met in a game, is now your girlfriend.", tx("2021 年 12 月", "December 2021")),
          her("今天发工资了吗～我看中一条裙子", "Got paid today? I saw a dress I love"),
          her("好想有人给我买呀 🥺", "Wish someone would buy it for me 🥺"),
        ],
        ask: tx("刚在一起一个月，你会：", "One month in. You:"),
        choices: [
          c(false, "把这个月代练挣的全转过去：「拿去，不够再说」", "Send her everything you made this month: \"Take it, ask if you need more\"",
            "刚恋爱就把全部收入交出去，等于告诉对方你没有底线，也让自己没有退路。心意可以表达，但要量力。", "Handing over your whole income a month in tells her you have no limits and leaves you no way back. Show you care, within your means."),
          c(true, "转一个小红包，说清楚「我也在攒钱」", "Send a small gift and say \"I'm saving up too\"",
            "表达心意，也说明自己的边界。真正在乎你的人，会尊重你攒钱的计划。", "You show you care and say where your limit is. Someone who cares about you will respect your plan to save."),
          c(false, "直接骂她捞女，拉黑", "Call her a gold digger and block her",
            "一次撒娇不等于图钱。给人贴标签解决不了问题，好好沟通边界才是正事。", "One playful ask doesn't make someone a gold digger. Labels solve nothing; talking about limits does."),
        ],
        real: tx("现实中，两人交往两年多，「胖猫」向女方转账 317 次，共 79.9 万余元。", "In real life, over two-plus years \"Fat Cat\" sent his girlfriend money 317 times, about ¥799,000 in all."),
      },
      {
        lines: [
          nar("分手又复合之后，小雨说她不想再异地了。", "After a breakup and a make-up, Rain says she is done with long distance.", tx("2023 年 2 月", "February 2023")),
          her("你来重庆吧，我们一起生活", "Come to Chongqing, let's live together"),
          her("你要是真爱我，就别犹豫", "If you really love me, don't hesitate"),
        ],
        ask: tx("你会：", "You:"),
        choices: [
          c(false, "马上推掉手头的单子、退租，带着全部积蓄就走", "Drop your clients, give up your flat and leave with all your savings at once",
            "搬去一座陌生城市是大事。没有收入计划、没有应急钱就把后路全断，任何一次争吵都会让你无处可去。", "Moving to a strange city is a big step. Burn every bridge with no income plan and no emergency money, and any fight leaves you with nowhere to go."),
          c(true, "答应一起规划：先想好到那边怎么挣钱，留够 3 个月生活费再搬", "Agree to plan it: work out how you'll earn there and keep 3 months of living money first",
            "愿意为感情改变，也要给自己留后路。爱和计划不冲突。", "Change for love, but keep a way back. Love and planning go together."),
        ],
        real: tx("现实中，双方约定 10 月一起在重庆生活。2023 年 10 月，「胖猫」从湖南郴州搬到重庆，在女方家附近租房。", "In real life they agreed to live in Chongqing from October. In October 2023 he moved from Chenzhou, Hunan, and rented a room near her home."),
      },
      {
        lines: [
          nar("你们开了一个情侣攒钱账户，两个人都能随时存、随时取。", "You open a couples' savings pot that either of you can pay into or take from at any time."),
          her("以后我们的钱都放这里，好不好", "Let's keep all our money here from now on, ok?"),
        ],
        ask: tx("你的打算是：", "Your plan:"),
        choices: [
          c(false, "每一笔收入都存进去，自己一分不留", "Put in every yuan you earn and keep nothing for yourself",
            "共同账户可以有，但每个人都要留一份只属于自己的钱。全部放进去，分开那天你连房租都付不起。", "A shared pot is fine, but each of you needs money of your own. Put in everything and the day you split you can't pay rent."),
          c(true, "约定每月各存多少，各自留一份自己的钱，存取都记下来", "Agree how much each puts in, each keep money of your own, and log every deposit and withdrawal",
            "规则说在前面、账记清楚，感情好的时候不伤和气，出了问题也说得清。", "Rules agreed up front and clear records keep the peace now and make things clear if it goes wrong."),
        ],
        real: tx("现实中，警方核实：这个账户里女方存入 23.6 万、取出 16.5 万，「胖猫」存入 17.3 万、取出 24.8 万。钱是双向流动的。", "In real life the police found she put ¥236k into that pot and took out ¥165k; he put in ¥173k and took out ¥248k. Money went both ways."),
      },
      {
        lines: [
          her("我想开个花店！你出钱，我来经营～", "I want to open a flower shop! You fund it, I run it"),
          her("大概要 7 万", "About ¥70k"),
        ],
        ask: tx("你会：", "You:"),
        choices: [
          c(false, "把攒下的钱全拿出来，什么都不用写", "Put in all your savings, no paperwork needed",
            "合伙出钱不写清楚，好的时候没事，散了就是一笔说不清的账。", "Money put into a joint business with nothing written down is fine until you split; then nobody can say whose it is."),
          c(true, "可以出，但写一份简单的约定：谁出多少、赚了怎么分、散了怎么退", "Fund it, but write a one-page agreement: who puts in what, how profit is shared, how money comes back if you split",
            "一页纸的约定，保护的是两个人。愿意写，说明对方也是认真的。", "One page protects both of you. If she's happy to sign, she's serious too."),
        ],
        real: tx("现实中，双方商议开花店，由「胖猫」出资 7 万元、女方经营，花店 2023 年 12 月开业。他去世后，女方应他父亲的要求退还了这 7 万元。", "In real life he put ¥70k into the flower shop she ran; it opened in December 2023. After his death she returned the ¥70k at his father's request."),
      },
      {
        lines: [
          nar("又一次分手。你给她发了很多消息，她都没回。凌晨，你一个人坐在出租屋里，觉得什么都没意义了。", "Another breakup. You've sent her message after message with no reply. In the small hours you sit alone in your rented room and nothing seems to matter any more.", tx("2024 年 4 月", "April 2024")),
          mine("我们还能回去吗", "Can we go back?"),
          mine("求你回我一句", "Please, just answer me"),
        ],
        ask: tx("这个凌晨，你会：", "Tonight, you:"),
        choices: [
          c(false, "继续一条接一条地发，再给她转钱求复合", "Keep messaging and send her money to win her back",
            "用转账换回应，只会让自己更卑微、更绝望。感情不是用钱续的。", "Paying for a reply only makes you feel smaller and more hopeless. You can't buy a relationship back."),
          c(false, "一个人扛着，谁也不告诉", "Carry it alone and tell no one",
            "最危险的就是一个人扛。情绪会骗人，让你以为没有出路。", "Carrying it alone is the most dangerous choice. Feelings lie and tell you there's no way out."),
          c(true, "给家人或好朋友打个电话，或者拨打心理援助热线 12356", "Call family or a close friend, or the 12356 mental-health helpline",
            "说出来，就有人能拉你一把。12356 是全国统一心理援助热线。分手很痛，但它不是终点。", "Say it out loud and someone can pull you back. 12356 is China's national mental-health helpline. A breakup hurts, but it isn't the end."),
        ],
        real: tx("现实中，2024 年 4 月 11 日凌晨，21 岁的「胖猫」在重庆长江大桥跳江离世。", "In real life, early on 11 April 2024, \"Fat Cat\", 21, died after jumping from the Yangtze River Bridge in Chongqing."),
      },
      {
        lines: [
          nar("事后，有人把你们的聊天记录、转账截图发到网上。几天之内，「捞女」的骂声铺天盖地，有人扒出了她的住址。", "Afterwards someone posts your chats and transfer screenshots online. Within days the internet is calling her a gold digger, and someone digs up her home address."),
          net("「转了几十万还被甩，标准捞女！」", "\"Took hundreds of thousands then dumped him. Textbook gold digger!\""),
          net("「谁有她地址？」", "\"Anyone got her address?\""),
        ],
        ask: tx("如果你是围观的网友，你会：", "If you were watching online, you would:"),
        choices: [
          c(false, "转发，跟着一起骂，顺手把地址也发出去", "Share it, pile on, and pass the address along",
            "截图只是一面之词。人肉、曝光住址、网暴，不管对方做了什么都是违法的。", "Screenshots are one side of the story. Doxxing and online mobbing are illegal, whatever the other person did."),
          c(true, "等官方调查结果，不转发别人的隐私", "Wait for the official findings and don't share anyone's private details",
            "真相往往和热搜不一样。不传播隐私、不网暴，是对所有人的保护。", "The truth is often not what's trending. Not spreading private details or piling on protects everyone."),
        ],
        real: tx("现实中，2024 年 5 月 19 日重庆警方通报：两人是真实恋爱关系，「胖猫」转给女方 79.9 万余元，女方转给「胖猫」及其亲属 46.3 万余元，女方不构成诈骗；发布她的隐私、引导网暴的行为违法。女方已全额退还恋爱期间经济往来的差额，并与「胖猫」父母和解。", "In real life, on 19 May 2024 Chongqing police reported: theirs was a real relationship; he sent her about ¥799k and she sent him and his family about ¥463k; she committed no fraud; posting her private details and stirring up abuse was illegal. She repaid the full difference and settled with his parents."),
      },
    ],
    lesson: tx("这一关其实没有「捞女」。真正要防的，是没有边界的付出、把全部人生押在一个人身上，和一个人扛着的深夜。", "There was no gold digger in this level. What to guard against is giving without limits, staking your whole life on one person, and facing the worst night alone."),
    recap: [
      tx("2021 年 11 月，两人在网络游戏里认识，12 月确定恋爱关系；交往两年多，多次分手、复合。", "They met in an online game in November 2021 and became a couple that December; over two-plus years they split up and got back together several times."),
      tx("2023 年 10 月，「胖猫」从湖南搬到重庆；他出资 7 万元和女方开了一家花店。", "In October 2023 he moved from Hunan to Chongqing and put ¥70k into a flower shop she ran."),
      tx("2024 年 4 月 11 日，21 岁的「胖猫」在重庆长江大桥跳江离世。他的姐姐随后在网上发布聊天记录和转账截图，并曝光女方住址等信息，网上一边倒骂女方「捞女」。", "On 11 April 2024 he died in Chongqing, aged 21. His sister then posted their chats and transfers and exposed the girlfriend's address; the internet branded her a gold digger."),
      tx("5 月 19 日警方通报：他向女方转账 317 次共 79.9 万余元，女方向他及其亲属转账 179 次共 46.3 万余元；双方是真实恋爱，女方不构成诈骗；曝光隐私的行为违法。女方退还了经济往来差额，并与他的父母和解。", "On 19 May the police reported: he sent her ¥799k over 317 transfers and she sent him and his family ¥463k over 179; it was a real relationship and not fraud; exposing her private details was illegal. She repaid the difference and settled with his parents."),
    ],
    sources: [{ name: "澎湃新闻：重庆警方通报「胖猫」事件详情", url: "https://www.thepaper.cn/newsDetail_forward_27435869" }],
  },
  {
    id: 2,
    title: tx("第二关 · 42 天的婚姻", "Level 2 · A 42-day marriage"),
    tagline: tx("拿把柄要钱，就是敲诈", "Money for silence is extortion"),
    basedOn: tx("改编自 2017 年「WePhone 创始人案」", "Adapted from the 2017 WePhone founder case"),
    me: tx("周明", "Ming"),
    her: tx("薇薇", "Vivi"),
    steps: [
      {
        lines: [
          nar("你叫周明，三十出头，自己创业做一款网络电话 App。你在婚恋网站上认识了薇薇，很快确定了恋爱关系。", "You're Ming, early thirties, founder of an internet-calling app. You meet Vivi on a dating site and are soon a couple.", tx("2017 年 3 月", "March 2017")),
          her("我们在海南买套房吧，以后去度假住", "Let's buy a place in Hainan for holidays"),
          her("首付你先出，房子写我们俩的名字～", "You cover the down payment, and we put both our names on it"),
        ],
        ask: tx("认识两个月，对方提出一起买房、你出首付：", "Two months in, she wants a flat together with you paying the deposit:"),
        choices: [
          c(false, "爽快答应，199 万首付马上转", "Say yes and wire the ¥1.99M deposit right away",
            "认识两个月就投入几百万，一旦关系破裂，这就是对方手里最大的筹码。", "Millions in after two months: if it falls apart, that's the biggest chip she holds."),
          c(true, "大额财产等关系稳定再说；真要买，先签好出资和产权的书面约定", "Wait on big assets until things are steady; if you buy, sign who paid what and who owns what first",
            "感情越热，越要把账算清楚。白纸黑字不是不信任，是给双方都留余地。", "The hotter the romance, the clearer the money must be. Putting it in writing isn't distrust; it protects you both."),
        ],
        real: tx("现实中，2017 年 5 月，二人买下海南一处房产，总价 319 万余元，男方支付首付款 199 万余元。", "In real life, in May 2017 they bought a ¥3.19M flat in Hainan; he paid the ¥1.99M deposit."),
      },
      {
        lines: [
          her("我们下个月就领证吧！", "Let's get married next month!"),
          her("你是不是根本不想娶我？", "Or don't you want to marry me at all?"),
        ],
        ask: tx("认识不到三个月，对方催着领证：", "Under three months in, she is pushing to marry:"),
        choices: [
          c(false, "立刻去领证，证明你的真心", "Marry at once to prove you mean it",
            "用领证「证明真心」是被情绪推着走。婚姻是法律关系，牵扯财产和责任。", "Marrying to \"prove\" love is being pushed by emotion. Marriage is a legal tie with money and duties attached."),
          c(true, "多相处一段，见双方家人、了解她的过往；结婚前做好婚前财产约定", "Spend more time together, meet both families, learn her past, and sign a prenup before marrying",
            "了解一个人需要时间。婚前财产协议保护的是两个人。", "Knowing someone takes time. A prenup protects both of you."),
        ],
        real: tx("现实中，2017 年 6 月 7 日，两人登记结婚。这段婚姻只存续了 42 天。", "In real life they married on 7 June 2017. The marriage lasted 42 days."),
      },
      {
        lines: [
          nar("结婚才一个多月，薇薇提出离婚。", "Barely a month after the wedding, Vivi asks for a divorce.", tx("2017 年 7 月", "July 2017")),
          her("离婚可以，精神损失费 1000 万", "Fine, divorce. ¥10 million for emotional damages"),
          her("海南的房子归我", "And the Hainan flat is mine"),
          her("不给？那我就去举报你和你的公司，看你怎么收场", "Won't pay? Then I'll report you and your company and see how that ends for you"),
        ],
        ask: tx("你会：", "You:"),
        choices: [
          c(false, "怕事情闹大，先答应下来，想办法凑钱", "Agree to keep it quiet and start raising the money",
            "以举报相要挟、索要财物，涉嫌敲诈勒索。答应了，只会被要得更多。", "Demanding money under threat of reporting you is extortion. Agree, and she'll want more."),
          c(true, "保持冷静，保存聊天记录和录音，马上找律师", "Stay calm, keep every message and recording, and get a lawyer now",
            "证据是保护自己最有力的武器。专业的事交给律师。", "Evidence is your strongest protection. Leave the legal side to a lawyer."),
          c(false, "回骂她，也威胁要曝光她", "Fire back and threaten to expose her too",
            "以牙还牙会让局面失控，也可能让你自己违法。", "Threat for threat spins out of control and can put you on the wrong side of the law."),
        ],
        real: tx("现实中，2017 年 7 月至 9 月，女方以举报男方及其公司相要挟，索要「精神损失费」1000 万元，并要求海南房产归她所有。", "In real life, from July to September 2017 she threatened to report him and his company, demanded ¥10M in \"emotional damages\" and the Hainan flat."),
      },
      {
        lines: [
          her("先打 660 万，剩下的慢慢给", "Send ¥6.6 million first, the rest later"),
          her("别报警，报了你公司就完了", "Don't call the police, or your company is finished"),
        ],
        ask: tx("对方要钱，还不许你报警：", "She wants money and says no police:"),
        choices: [
          c(false, "转 660 万「封口费」，求个清静", "Pay the ¥6.6M to make it stop",
            "敲诈从不会因为你给了钱就停下。给得越多，对方越确定你会怕。", "Extortion never stops because you paid. The more you pay, the surer she is that you're scared."),
          c(true, "报警。拿举报相要挟要钱，就是敲诈勒索", "Call the police. Threatening to report someone for money is extortion",
            "敲诈勒索是刑事犯罪，数额特别巨大要判十年以上。报警不是把事情闹大，是让法律来管。", "Extortion is a crime; for sums this large the sentence is over ten years. Calling the police isn't making a scene, it's letting the law handle it."),
        ],
        real: tx("现实中，2017 年 7 月 18 日，男方被迫支付 660 万元，并把海南房产的购买人变更为女方。拿到钱后，女方仍多次威胁他、索要剩余的钱。", "In real life, on 18 July 2017 he was forced to pay ¥6.6M and sign the Hainan flat over to her. After that she kept threatening him for the rest."),
      },
      {
        lines: [
          nar("你最怕的，是公司的一些问题被翻出来。", "What scares you most is some of your company's problems coming out."),
        ],
        ask: tx("面对自己的软肋：", "About your weak spot:"),
        choices: [
          c(false, "继续捂着，只要对方不说就行", "Keep it hidden and hope she stays quiet",
            "软肋一直捂着，就永远有人能拿捏你。", "As long as the weak spot stays hidden, someone can always hold it over you."),
          c(true, "找律师梳理风险，该整改就整改，主动把问题解决掉", "Have a lawyer go through the risks, fix what needs fixing, deal with it yourself",
            "把软肋变成已经解决的问题，别人就再也威胁不了你。", "Turn the weak spot into a solved problem and nobody can threaten you with it."),
        ],
        real: tx("现实中，他在数千字的遗书里写道：被逼签下 1000 万元的离婚赔偿，公司资金链也断了。", "In real life, his note of several thousand words said he'd been forced to sign a ¥10M divorce payout and his company had run out of cash."),
      },
      {
        lines: [
          nar("钱给了，威胁却没有停。你整夜整夜睡不着，觉得已经无路可走。", "You paid, but the threats didn't stop. Night after night you can't sleep and feel there's no way out.", tx("2017 年 9 月", "September 2017")),
          her("剩下的钱什么时候给？", "When do I get the rest?"),
        ],
        ask: tx("这个深夜，你会：", "Tonight, you:"),
        choices: [
          c(false, "一个人扛，不想让任何人知道", "Carry it alone so no one finds out",
            "越是觉得无路可走，越不能一个人扛。", "The more it feels like there's no way out, the less you should carry it alone."),
          c(true, "告诉家人和律师，拨打心理援助热线 12356，同时报警", "Tell your family and your lawyer, call the 12356 helpline, and go to the police",
            "家人、律师、警察和热线，都是你的路。走不下去的时候，让别人陪你走一段。", "Family, lawyer, police, helpline: these are all ways out. When you can't go on, let someone walk with you."),
        ],
        real: tx("现实中，2017 年 9 月 7 日，男方坠楼身亡。2025 年 9 月 19 日，北京海淀法院以敲诈勒索罪判处女方有期徒刑 12 年，并处罚金 10 万元，判决已生效。", "In real life he fell to his death on 7 September 2017. On 19 September 2025 a Beijing court sentenced her to 12 years for extortion and fined her ¥100k; the verdict is final."),
      },
    ],
    lesson: tx("真正要防的「捞女」，不是会撒娇的女孩，而是把感情当筹码、拿把柄要钱的人。闪婚别急着投钱；被要挟，第一时间保存证据、报警、找律师。", "The gold digger to watch for isn't a girl who likes gifts; it's someone who uses love as leverage and your secrets for money. Don't rush money into a whirlwind marriage, and if you're threatened, keep evidence, call the police, get a lawyer."),
    recap: [
      tx("2017 年 3 月，两人确定恋爱关系；5 月买下海南房产，男方付首付 199 万余元；6 月 7 日结婚，婚姻只存续了 42 天。", "March 2017: they became a couple. May: they bought a Hainan flat, he paid the ¥1.99M deposit. 7 June: they married; the marriage lasted 42 days."),
      tx("7 月至 9 月，女方以举报男方及其公司相要挟，索要 1000 万元和海南房产。7 月 18 日男方被迫付了 660 万元并把房子转到她名下，之后她仍不断威胁。", "July–September: threatening to report him and his company, she demanded ¥10M and the flat. On 18 July he paid ¥6.6M and signed the flat over; the threats went on."),
      tx("2017 年 9 月 7 日，男方坠楼身亡。2023 年民事判决认定女方「在婚恋过程中经济特征明显」「离婚过程中采取了胁迫方式」，判她退还近千万财物。", "On 7 September 2017 he fell to his death. A 2023 civil ruling found she had pursued money throughout and used coercion in the divorce, and ordered nearly ¥10M returned."),
      tx("2025 年 9 月 19 日，北京海淀法院以敲诈勒索罪判处女方有期徒刑 12 年、罚金 10 万元；她当庭认罪认罚，没有上诉，判决已生效。", "On 19 September 2025 a Beijing Haidian court sentenced her to 12 years for extortion and a ¥100k fine; she pleaded guilty and did not appeal."),
    ],
    sources: [{ name: "人民日报：翟某某一审获刑 12 年", url: "https://www.peopleapp.com/column/30050311968-500007098548" }],
  },
];

const levelOf = (id: number) => LEVELS.find((l) => l.id === id);

let ready: Promise<void> | null = null;
function ensure() {
  ready ??= (async () => {
    await sql`create table if not exists story_runs (
      id text primary key, wallet text not null, level int not null, paid int not null default 0,
      started_at timestamptz not null default now(), ended_at timestamptz, hearts int, passed boolean, reward int)`;
    await sql`create table if not exists story_clears (
      wallet text not null, level int not null, reward int not null, cleared_at timestamptz not null default now(),
      primary key (wallet, level))`;
  })();
  return ready;
}

async function clearedOf(wallet: string | null) {
  if (!wallet) return {} as Record<number, number>;
  const rows = await sql<{ level: number; reward: number }[]>`select level, reward from story_clears where wallet = ${wallet}`;
  return Object.fromEntries(rows.map((r) => [r.level, r.reward])) as Record<number, number>;
}

/** the script + what this wallet has cleared (reward paid per level) */
export async function storyLevels(token: string | undefined) {
  await ensure();
  const wallet = await walletOf(token);
  return { reward: STORY_REWARD, entry: ENTRY, hearts: HEARTS, rate: await rateNow(), levels: LEVELS, cleared: await clearedOf(wallet) };
}

/** start a try: free once the level is cleared, else ENTRY (bonus first); `practice` when the balance is short */
export async function storyStart(token: string | undefined, levelId: number) {
  const wallet = await walletOf(token);
  if (!wallet) return { error: "login" as const };
  if (!levelOf(levelId)) return { error: "no such level" as const };
  await ensure();
  const runId = randomBytes(12).toString("base64url");
  const r = await sql.begin(async (tx) => {
    const [done] = await tx`select 1 from story_clears where wallet = ${wallet} and level = ${levelId}`;
    let paid = 0;
    if (!done) {
      const [p] = await tx<{ bonus: string; cash: string }[]>`select bonus, cash from boat_players where wallet = ${wallet} for update`;
      const bonus = Number(p?.bonus ?? 0), cash = Number(p?.cash ?? 0);
      if (bonus + cash < ENTRY) return { practice: true as const };
      const fromBonus = Math.min(bonus, ENTRY);
      await tx`update boat_players set bonus = bonus - ${fromBonus}, cash = cash - ${ENTRY - fromBonus} where wallet = ${wallet}`;
      paid = ENTRY;
    }
    await tx`insert into story_runs (id, wallet, level, paid) values (${runId}, ${wallet}, ${levelId}, ${paid})`;
    return { id: runId, paid, cleared: !!done };
  });
  return { ...r, me: await me(wallet) };
}

/** score the choices (option index per step, in script order); the first clear pays the reward */
export async function storyEnd(token: string | undefined, runId: string, choices: unknown) {
  const wallet = await walletOf(token);
  if (!wallet) return { error: "login" as const };
  await ensure();
  const rate = await rateNow();
  const out = await sql.begin(async (tx) => {
    const [run] = await tx<{ level: number; started_at: Date; ended_at: Date | null }[]>`
      select level, started_at, ended_at from story_runs where id = ${runId} and wallet = ${wallet} for update`;
    if (!run) return { error: "not found" as const };
    if (run.ended_at) return { error: "ended" as const };
    const level = levelOf(run.level)!;
    const picks = Array.isArray(choices) ? choices.map(Number) : [];
    if (picks.length !== level.steps.length || picks.some((p, i) => !Number.isInteger(p) || p < 0 || p >= level.steps[i].choices.length)) return { error: "bad choices" as const };
    if ((Date.now() - run.started_at.getTime()) / 1000 < MIN_SECS) return { error: "too fast" as const };
    const wrong = picks.filter((p, i) => !level.steps[i].choices[p].ok).length;
    const hearts = Math.max(0, HEARTS - wrong);
    const passed = hearts > 0;
    let reward = 0;
    if (passed) {
      const amount = Math.floor(STORY_REWARD * rate);
      const [first] = await tx`insert into story_clears (wallet, level, reward) values (${wallet}, ${run.level}, ${amount}) on conflict do nothing returning level`;
      if (first) {
        reward = amount;
        await tx`update boat_players set cash = cash + ${reward}, earned = earned + ${reward} where wallet = ${wallet}`;
      }
    }
    await tx`update story_runs set ended_at = now(), hearts = ${hearts}, passed = ${passed}, reward = ${reward} where id = ${runId}`;
    return { hearts, passed, reward };
  });
  if ("error" in out) return out;
  return { ...out, rate, me: await me(wallet), cleared: await clearedOf(wallet) };
}
