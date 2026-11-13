// 书信簿 · 省 token
// 用暗号交给 AI 的信会整封写进你的消息；这条消息留在聊天记录里，以后每一轮都会再发一遍。
// 生成时（只改这一次发给 AI 的那份，不动聊天记录）把较早消息里的信换成一句话：
// 那封信 AI 当时已经读过，读信人记得什么由世界书里的记忆负责。

// 暗号本身带括号（【信件 【信1】｜文森特 写给 提奥｜…】），所以暗号那段只认到“｜”为止
const OLD_BLOCK_RE = /【信件 ([^｜\n]+?)｜([^】\n]*)】[\s\S]*?【信件完】/g;
export function trimOldLetters(chat, keep) {
    if (!Array.isArray(chat) || !(keep > 0)) return 0;
    let saved = 0;
    const until = chat.length - keep;
    for (let i = 0; i < until; i++) {
        const m = chat[i];
        if (!m || typeof m.mes !== 'string' || !m.mes.includes('【信件完】')) continue;
        const mes = m.mes.replace(OLD_BLOCK_RE, (all, code, head) => {
            const short = `【信件 ${code}｜${head}】（这封信之前已经整封读过，原文这里从略；剧情里谁记得什么，以读信人的记忆为准）【信件完】`;
            if (short.length >= all.length) return all;
            saved += all.length - short.length;
            return short;
        });
        // 换成一份新的消息对象：只影响这次发给 AI 的内容，聊天记录里还是整封信
        if (mes !== m.mes) chat[i] = { ...m, mes };
    }
    return saved;
}
