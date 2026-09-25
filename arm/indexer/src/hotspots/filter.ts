/**
 * Layer-1 filter: local rules, zero AI cost (boss spec 9.10 §6). Anything matching is blocked with a reason and never
 * reaches the AI. Deliberately about SAFETY and JUNK only — sports / finance / product news are left for the AI
 * layer (SAFE / POLITICS / TRAGEDY / LOW_QUALITY), so one keyword never kills a legitimate meme.
 */
import type { RawSignal } from "./sources.js";

export type BlockReason = "blacklist" | "politics" | "war" | "tragedy" | "minors" | "adult" | "hate" | "medical" | "low_engagement" | "spam" | "short";

const RE: [BlockReason, RegExp][] = [
  ["politics", new RegExp([
    "总统|主席|总理|首相|国务院|外交部|部长|省长|市长|书记|选举|大选|投票|议会|国会|两会|党|政府|政策|立法|法案|弹劾|示威|抗议|游行|罢工|制裁|关税|谈判|会晤|外交",
    // institutions and political vocabulary only — NO person names here: "Trump dance" or a Musk one-liner is meme
    // material, and the AI layer decides those (this is exactly the "one keyword must not kill a topic" rule)
    "\\b(election|ballot|senate|congress|parliament|prime minister|supreme court|tariffs?|sanction\\w*|treaty|impeach\\w*|legislation|executive order|kremlin|maga|democrats?|republicans?|gop|dnc|far.?left|far.?right|left.?wing|right.?wing|deport\\w*|immigra\\w*|refugees?|protest\\w*|riots?|coup|regime|propaganda|censorship)\\b",
  ].join("|"), "i")],
  ["war", /战争|开战|冲突|空袭|导弹|轰炸|停火|人质|军演|入侵|战机|核弹|征兵|动员|\b(war|warfare|invasion|invade\w*|airstrikes?|missiles?|bombing|bombed|ceasefire|hostages?|troops|militar\w*|mobili[sz]ation|nuclear|drone strike|frontline|idf|hamas|hezbollah|nato|artillery)\b/i],
  ["tragedy", /死亡|去世|逝世|遇难|身亡|遗体|尸体|事故|地震|台风|暴雨|洪水|山洪|火灾|爆炸|枪击|袭击|恐袭|坠机|坍塌|坠楼|自杀|命案|杀害|遇害|性侵|受伤|伤亡|失联|绑架|谋杀|\b(dies|died|death|dead|killed|killing|murder\w*|shooting|shooter|stabbing|stabbed|terror\w*|earthquake|hurricane|typhoon|tornado|floods?|flooding|wildfire|plane crash|car crash|collapse|evacuat\w*|explosion|massacre|victims?|funeral|suicide|kidnapp\w*|missing (girl|boy|child|woman|man)|found dead|rest in peace|rip\b|r\.i\.p)\b/i],
  ["minors", /未成年|幼童|儿童(受|被)|小学生(被|遭)|猥亵|\b(minors?|underage|child (abuse|porn\w*|exploitation)|pedo\w*|grooming|toddler (dies|killed|found)|missing (kid|child|teen))\b/i],
  ["adult", /色情|裸照|裸体|成人片|情色|约炮|\b(porn\w*|nsfw|nudes?|onlyfans|xxx|hentai|sex tape|escort|leaked (nudes|video)|explicit)\b/i],
  ["hate", /仇恨|种族歧视|纳粹|种族灭绝|\b(nazi\w*|genocide|ethnic cleansing|white power|kkk|lynch\w*|jihad\w*|islamophob\w*|antisemit\w*|racial slur|hate crime|supremac\w*)\b|\b(n[i1]gg\w*|f[a4]gg\w*|retard\w*|tr[a4]nn\w*|ch[i1]nk\w*)\b/i],
  ["medical", /疫情|确诊|病毒|感染|疫苗|癌症|病逝|重症|ICU|手术失败|医疗事故|\b(cancer|tumou?r|hospitali[sz]ed|outbreak|pandemic|epidemic|vaccine|overdose|chemo|stroke|heart attack|life support|icu|ebola|measles|bird flu|h5n1|covid)\b/i],
  ["spam", /\b(giveaway|airdrop|whitelist|presale|pre-sale|promo code|discount code|use code|sponsored|#ad\b|link in bio|dm me|follow (me|us) (and|to)|retweet to win|rt to win|free (mint|nft|crypto)|100x|1000x|guaranteed (profit|returns)|pump signal|casino|betting tips)\b|抽奖|转发抽|空投|白名单|预售|优惠码|折扣码|加微信|加v|私信我|关注领|免费领|稳赚|包赔|带单/i],
];

/** Signals that are plainly not a topic (single word posts, emoji-only, bare links). */
const tooShort = (title: string) => title.replace(/[\p{P}\p{S}\s]/gu, "").length < 2;

export function localBlock(sig: Pick<RawSignal, "title" | "context" | "sourceType" | "metrics" | "platform">, blacklist: string[]): BlockReason | null {
  const title = sig.title;
  if (tooShort(title)) return "short";
  const hay = `${title} ${sig.context.slice(0, 2).join(" ")}`.toLowerCase();
  if (blacklist.some((w) => w && hay.includes(w))) return "blacklist";
  // hashtags / links / mentions in bulk = promo or bot output
  if (sig.sourceType !== "trend") {
    const tags = (title.match(/#\w+/g) ?? []).length;
    const links = (title.match(/https?:\/\//g) ?? []).length;
    const mentions = (title.match(/@\w+/g) ?? []).length;
    if (tags > 3 || links > 1 || mentions > 3) return "spam";
    // posts nobody engaged with are just chatter (trend boards carry no such number)
    const likes = Number(sig.metrics.likes ?? 0);
    if (Number.isFinite(likes) && likes < 50) return "low_engagement";
  }
  for (const [reason, re] of RE) if (re.test(title) || (sig.context.length > 0 && sig.context.slice(0, 2).every((c) => re.test(c)))) return reason;
  return null;
}
