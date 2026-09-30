// 翻译与新闻分类共用的大模型调用；配置来自 /etc/weekly-rocketchat.env 的 AI_* 变量。
export function llmConfigured(env = process.env) {
  return Boolean(env.AI_API_BASE && env.AI_API_KEY && env.AI_MODEL);
}

export async function askLlm(prompt, { env = process.env, fetchImpl = fetch, timeoutMs = 60_000, maxTokens = 2000 } = {}) {
  const base = String(env.AI_API_BASE ?? '').replace(/\/$/, '');
  const isAnthropic = (env.AI_API_PROTOCOL || 'openai') === 'anthropic';
  const response = await fetchImpl(isAnthropic ? `${base}/messages` : `${base}/chat/completions`, {
    method: 'POST',
    headers: isAnthropic
      ? { 'content-type': 'application/json', 'x-api-key': env.AI_API_KEY, 'anthropic-version': '2023-06-01' }
      : { 'content-type': 'application/json', authorization: `Bearer ${env.AI_API_KEY}` },
    body: JSON.stringify({ model: env.AI_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`LLM request failed: HTTP ${response.status}`);
  const payload = await response.json();
  return isAnthropic
    ? (payload?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
    : payload?.choices?.[0]?.message?.content ?? '';
}

// 从模型回复中取出 JSON 数组，并要求长度与输入一致、元素都是非空字符串。
export function parseStringArray(text, expectedLength) {
  const json = /\[[\s\S]*\]/.exec(text)?.[0];
  let parsed = null;
  try { parsed = json ? JSON.parse(json) : null; } catch { /* handled below */ }
  if (!Array.isArray(parsed) || parsed.length !== expectedLength || !parsed.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error('LLM response has an unexpected shape');
  }
  return parsed.map((item) => item.trim());
}
