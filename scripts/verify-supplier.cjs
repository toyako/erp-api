const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = 'D:/Project/erp-platform/erp-api';
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
process.env.ERP_DB_ADAPTER = 'prisma';
process.env.PORT = '3101';
delete process.env.API_PORT;

const BASE = 'http://127.0.0.1:3101/api';
const lines = [];
const ok = (n, d) => lines.push(`PASS ${n}${d ? ` :: ${d}` : ''}`);
const bad = (n, d) => lines.push(`FAIL ${n}${d ? ` :: ${d}` : ''}`);

const child = spawn(process.execPath, ['dist/main.js'], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => { log += d.toString(); });
child.stderr.on('data', (d) => { log += d.toString(); });

async function waitReady() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

(async () => {
  if (!(await waitReady())) {
    bad('服务启动');
  } else {
    ok('服务启动');
    const list1 = await (await fetch(`${BASE}/purchase/suppliers`)).json();
    lines.push(`suppliers_before=${list1.total}`);
    if (list1.total >= 2) ok('seed 供应商已入库', `total=${list1.total}`);
    else bad('供应商 seed 缺失');

    const code = `SUP-T${Date.now().toString().slice(-6)}`;
    const createRes = await fetch(`${BASE}/purchase/suppliers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: '接口验证供应商', contact: '张三', phone: '020-12345678', rating: 4 }),
    });
    const created = await createRes.json();
    if (createRes.status < 300 && created.id) ok('POST 新建供应商', `code=${created.code}`);
    else bad('新建供应商失败', JSON.stringify(created).slice(0, 160));

    const list2 = await (await fetch(`${BASE}/purchase/suppliers`)).json();
    lines.push(`suppliers_after=${list2.total}`);
    if (list2.total === list1.total + 1) ok('新供应商已落库');
    else bad('供应商数量未增加');

    const dup = await fetch(`${BASE}/purchase/suppliers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name: '重复编码' }),
    });
    lines.push(`duplicate_code_status=${dup.status}`);
  }

  child.kill();
  const failed = lines.filter((l) => l.startsWith('FAIL'));
  lines.push('---');
  lines.push(failed.length === 0 ? 'SUPPLIER OK' : `SUPPLIER FAILED (${failed.length})`);
  fs.writeFileSync('D:/Project/erp-platform/.supplier-e2e.txt', `${lines.join('\n')}\n`, 'ascii');
  fs.writeFileSync('D:/Project/erp-platform/.supplier-server.log', log.slice(-2000), 'utf8');
})();
