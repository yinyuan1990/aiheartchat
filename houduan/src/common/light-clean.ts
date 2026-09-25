import { Logger } from '@nestjs/common';
import { callModel } from './ai-model';

const logger = new Logger('LightClean');

/** 本地词表：AI 调不通 / 输出不可信时兜底；AI 处理完也再过一遍。只收不会误伤的词（「逼」「屌」这类多义字交给 AI 看上下文） */
const DICT: [RegExp, string][] = [
  [/阴茎/g, 'YJ'], [/鸡巴|鸡吧|几把|鸡儿/g, 'JB'], [/肉棒/g, 'RB'], [/龟头/g, 'GT'], [/睾丸/g, 'GW'], [/阴囊/g, 'YN'],
  [/阴道/g, 'YD'], [/阴蒂/g, 'YD'], [/阴唇/g, 'YC'], [/阴部/g, 'YB'], [/阴毛/g, 'YM'], [/小穴/g, 'XX'], [/骚穴/g, 'SX'], [/屄/g, 'B'],
  [/奶子/g, 'NZ'], [/奶头/g, 'NT'], [/乳头/g, 'RT'], [/乳房/g, 'RF'],
];

const SYSTEM = [
  '你是文字审校。把文中明显的性器官词（包括俗称、脏话里的，如 阴茎、鸡巴、肉棒、龟头、睾丸、阴道、阴蒂、阴唇、小穴、屄、奶子、乳头、乳房）替换成这个词的拼音首字母大写，例如 阴茎→YJ、鸡巴→JB、阴道→YD、奶子→NZ、乳头→RT。',
  '首字母之间不加空格（小穴→XX，不是 X X）。除此之外一个字都不许改：不改写、不删减、不加字、不改标点和换行，错别字也保留。「逼迫」「傻逼」这类不是指性器官的不要改。没有这类词就原样输出。',
  '只输出 JSON：{"text": "处理后的全文"}',
].join('\n');

function dictClean(text: string): string {
  return DICT.reduce((s, [re, to]) => s.replace(re, to), text);
}

/** AI 偶尔把首字母写成「X X」：夹在中文 / 标点中间的带空格大写字母合并 */
function joinInitials(text: string): string {
  return text.replace(/([\u4e00-\u9fff\p{P}])([A-Z](?: [A-Z])+)(?=[\u4e00-\u9fff\p{P}])/gu, (_m, pre: string, letters: string) => pre + letters.replace(/ /g, ''));
}

/**
 * 浅处理：只把明显的性器官词换成拼音首字母（和谐），其余原样保留。
 * DeepSeek 找词（能看上下文）+ 本地词表兜底；AI 输出长度和原文差太多（说明它改写了）就不用它的结果。
 */
export async function lightClean(text: string): Promise<string> {
  if (!text.trim()) return text;
  if (!process.env.AI_API_KEY) return dictClean(text);
  try {
    const raw = await callModel([{ role: 'system', content: SYSTEM }, { role: 'user', content: text }], 0, Math.min(8000, Math.ceil(text.length * 1.5) + 200));
    const out = String(JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim()).text ?? '');
    const ratio = out.length / text.length;
    if (!out || ratio < 0.85 || ratio > 1.05) {
      logger.warn(`AI 浅处理输出长度不对（${text.length} → ${out.length}），改用词表`);
      return dictClean(text);
    }
    return dictClean(joinInitials(out));
  } catch (e: any) {
    logger.warn(`AI 浅处理失败，改用词表：${e?.message ?? e}`);
    return dictClean(text);
  }
}
