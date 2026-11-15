const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

// 只扫源码目录；docs/、ADR、THIRD-PARTY-NOTICES 中作为来源说明出现的上游名称属合法
const scanDirs = [
  'apps/erp-admin/src',
  'apps/erp-api/src',
  'apps/desktop/src',
  'packages/contracts/src',
  'packages/config/src',
  'packages/domain-kit/src',
  'packages/ui/src',
];

const forbidden = [
  '卡密', '机器码', '封包', 'Flash', 'SWF', '仙域',
  'apifoxmock', 'un-pany', 'juejin', 'v3-admin-vite',
];

const exts = new Set(['.ts', '.vue', '.js', '.cjs', '.css', '.html', '.json', '.prisma']);
const skipDirs = new Set(['dist', 'node_modules', 'release']);

const hits = [];
let scanned = 0;

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!exts.has(path.extname(entry.name))) continue;
    scanned += 1;
    const text = fs.readFileSync(full, 'utf8');
    for (const word of forbidden) {
      if (text.includes(word)) {
        hits.push(path.relative(root, full) + ' -> ' + word);
      }
    }
  }
}

for (const d of scanDirs) walk(path.join(root, d));

// 环境/部署配置不参与源码 walk，但必须扫：生产环境外链残留会直接导致部署事故
const extraFiles = [
  'apps/erp-admin/.env',
  'apps/erp-admin/.env.development',
  'apps/erp-admin/.env.production',
  'apps/erp-admin/.env.staging',
  '.env.example',
  'vercel.json',
  'wrangler.toml',
  'supabase/config.toml',
];
for (const f of extraFiles) {
  const full = path.join(root, f);
  if (!fs.existsSync(full)) continue;
  scanned += 1;
  const text = fs.readFileSync(full, 'utf8');
  for (const word of forbidden) {
    if (text.includes(word)) hits.push(f + ' -> ' + word);
  }
}

if (hits.length) {
  console.error('RESIDUAL CHECK FAILED:\n' + hits.join('\n'));
  process.exit(1);
}
console.log('residual check OK: scanned ' + scanned + ' files, 0 hits');
