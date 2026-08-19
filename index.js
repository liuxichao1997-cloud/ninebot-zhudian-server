import express from 'express';
import cors from 'cors';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const TDOCS_TOKEN = process.env.TDOCS_TOKEN || '8c8d1280ea4a4b0b8a7dfb856bc4e123';
const TDOCS_API = 'https://docs.qq.com/openapi/mcp';

// ── Data helpers ──
function readData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
  catch { return []; }
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Tencent Docs API ──
function callTdocsApi(method, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: method, arguments: args } });
    const req = https.request(TDOCS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': TDOCS_TOKEN }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── App ──
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Health check
app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', reports: readData().length, timestamp: new Date().toISOString() });
});

// Get all reports
app.get('/api/reports', (req, res) => {
  const reports = readData();
  res.json(reports);
});

// Get single report
app.get('/api/reports/:id', (req, res) => {
  const reports = readData();
  const report = reports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  res.json(report);
});

// Submit report + sync to Tencent Docs
app.post('/api/reports', async (req, res) => {
  try {
    const { report, docContent } = req.body;
    if (!report || !report.step1) return res.status(400).json({ error: 'Invalid report format' });

    const reports = readData();
    const stored = { ...report, syncedAt: new Date().toISOString(), tdocUrl: null };
    reports.unshift(stored);
    writeData(reports);

    // Try syncing to Tencent Docs
    let tdocUrl = null;
    try {
      const title = `[驻店报告] ${report.step1.storeName} - ${report.step1.date}`;
      const tdocContent = docContent || buildDefaultContent(report);
      const result = await callTdocsApi('create_smartcanvas_by_mdx', { title, mdx: tdocContent });
      if (!result.error) {
        tdocUrl = result.result.structuredContent.url;
        stored.tdocUrl = tdocUrl;
        writeData(reports); // Update with URL
      }
    } catch(e) {
      console.error('Tencent Docs sync failed:', e.message);
    }

    res.json({ success: true, id: stored.id, tdocUrl });
  } catch(e) {
    console.error('Submit error:', e);
    res.status(500).json({ error: e.message });
  }
});

// Delete a report
app.delete('/api/reports/:id', (req, res) => {
  let reports = readData();
  const before = reports.length;
  reports = reports.filter(r => r.id !== req.params.id);
  if (reports.length === before) return res.status(404).json({ error: 'Not found' });
  writeData(reports);
  res.json({ success: true });
});

// Export all data
app.get('/api/export', (req, res) => {
  const reports = readData();
  res.setHeader('Content-Disposition', 'attachment; filename=ninebot-reports.json');
  res.json(reports);
});

function buildDefaultContent(report) {
  const s1 = report.step1 || {};
  const s2 = report.step2 || {};
  let md = '# 九号驻店报告\n\n';
  md += `**门店**: ${s1.storeName} | **日期**: ${s1.date} | **人员**: ${s1.visitor}\n`;
  md += `**等级**: ${s1.tier}级 | **类型**: ${s1.bizType || '未填'}\n\n`;
  md += `## 驻店目标\n${s1.goals || '未填'}\n\n`;
  if (s2.basePct !== undefined) md += `## 巡检得分率: ${s2.basePct}%\n\n`;
  if (report.step3?.experiences?.length) {
    md += `## 优秀经验 (${report.step3.experiences.length}条)\n`;
    report.step3.experiences.forEach(e => md += `- **${e.name}**: ${e.detail}\n`);
  }
  if (report.step4?.issues?.length) {
    md += `## 不足之处 (${report.step4.issues.length}条)\n`;
    report.step4.issues.forEach(i => md += `- [${i.severity}] ${i.desc}\n`);
  }
  return md;
}

app.listen(PORT, () => {
  console.log(`🚀 九号驻店服务端已启动: http://localhost:${PORT}`);
  console.log(`📊 已有 ${readData().length} 条驻店报告`);
});
