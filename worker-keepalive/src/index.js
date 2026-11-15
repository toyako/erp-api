/**
 * Render 免费层保活 Worker
 * Render 免费实例 15 分钟无请求即休眠，冷启动 30-60s。
 * 本 Worker 每 5 分钟 ping 一次 /api/health，保持实例常驻。
 */
const TARGET = 'https://erp-api-01nu.onrender.com/api/health';

export default {
  async scheduled(_event, _env, ctx) {
    ctx.waitUntil(
      fetch(TARGET, { method: 'GET' }).then(
        (res) => console.log(`keepalive ${res.status}`),
        (error) => console.error(`keepalive failed: ${error}`),
      ),
    );
  },

  async fetch() {
    const res = await fetch(TARGET).catch(() => null);
    return new Response(
      JSON.stringify({
        worker: 'erp-api-keepalive',
        target: TARGET,
        upstream: res ? res.status : 'unreachable',
        checkedAt: new Date().toISOString(),
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  },
};
