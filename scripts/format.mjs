// 各推送共用的日期与数字格式。
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export const RANK_MARKS = ['🥇', '🥈', '🥉'];
export const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

export function beijingDate(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
}

// "2026-09-29" -> "9月29日 周二"
export function formatDayLabel(isoDate) {
  const [year, month, day] = isoDate.split('-').map(Number);
  return `${month}月${day}日 ${WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]}`;
}

// 1234 -> "1.2k"，56789 -> "57k"
export function formatCount(count) {
  if (!Number.isFinite(count)) return '';
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
}

// 标题和说明放进第一张卡片：部分客户端把消息正文画在卡片下方，放进卡片才能保证在最上面。
// 正文留空（用户确认接受通知预览只显示发送者）。
export function withHeaderCard({ title, description, color }, attachments) {
  return { text: '', attachments: [{ color, title, text: description }, ...attachments] };
}

export function decodeEntities(text) {
  return String(text)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}
