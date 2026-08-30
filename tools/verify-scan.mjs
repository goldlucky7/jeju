/**
 * 탑승권 인식이 실제로 되는지 브라우저에서 확인한다.
 *
 *   python3 tools/make-test-passes.py /tmp/passes     # 시험 이미지 먼저 만들고
 *   npx http-server -p 8897 -s .                      # 사이트를 띄운 뒤
 *   node tools/verify-scan.mjs /tmp/passes            # 이 스크립트를 돌린다
 *
 * 하는 일 세 가지
 *   1) 인식기 파일(lib/)이 제대로 읽히는지
 *   2) 시험 이미지 한 장 한 장을 실제 스캔 경로로 돌려 인식되는지
 *   3) 캔버스로 가짜 카메라를 만들어 실시간 스캔 전체 흐름이 도는지
 *   4) 안드로이드 기기 내장 인식기가 고장 났을 때 ZXing 으로 넘어가는지
 *
 * 이 컨테이너에는 카메라가 없어서 getUserMedia 가 NotFoundError 를 낸다.
 * 그래서 3)은 캔버스 captureStream 으로 진짜 MediaStream 을 만들어 대신 물린다.
 */
import fs from 'fs';
import path from 'path';

const DIR  = process.argv[2] || '/tmp/passes';
const BASE = process.env.BASE || 'http://127.0.0.1:8897/index.html';

let chromium;
for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright/index.mjs']) {
  try { ({ chromium } = await import(p)); break; } catch (e) {}
}
if (!chromium) { console.error('playwright 를 찾지 못했습니다. npm i -D playwright'); process.exit(1); }

const expect = fs.readFileSync(path.join(DIR, 'expect.txt'), 'utf8').trim();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

// 1) 인식기 준비
const ready = await page.evaluate(async () => {
  const zx = !!(await ensureZXing());
  const jq = !!(await ensureJsQR());
  const eng = await pickEngine();
  return { zx, jq, native: 'BarcodeDetector' in window, engine: eng ? eng.label.replace(/<[^>]+>/g, '') : '없음' };
});
console.log('인식기 준비');
console.log('  기기 내장 :', ready.native ? '있음' : '없음(브라우저 한계 · 폰에서는 안드로이드 크롬에 있음)');
console.log('  ZXing     :', ready.zx ? 'OK' : '실패');
console.log('  jsQR      :', ready.jq ? 'OK' : '실패');
console.log('  선택된 엔진:', ready.engine.slice(0, 60));
if (!ready.zx && !ready.jq) { console.error('\n인식기를 못 읽었습니다. lib/ 폴더가 있는지 확인하세요.'); process.exit(1); }

// 2) 시험 이미지별 인식
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.png')).sort();
let ok = 0;
console.log('\n이미지별 인식 (실제 스캔과 같은 방식으로 여러 갈래를 번갈아 시도)');
for (const f of files) {
  const b64 = fs.readFileSync(path.join(DIR, f)).toString('base64');
  const got = await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64,' + b64; });
    for (let i = 0; i < SCAN_PASSES.length; i++) {
      const ps = SCAN_PASSES[i];
      const c = grabCanvas(img, img.width, img.height, ps);
      const raw = c ? (zxDecodeCanvas(window.ZXing, c, ps.bin) || jsqrCanvas()) : null;
      if (raw) return raw;
    }
    return null;
  }, b64);
  const good = got === expect;
  if (good) ok++;
  console.log('  ', f.replace('.png', '').padEnd(17), good ? '✅' : (got ? '⚠️ 다른 내용을 읽음' : '❌'));
}
console.log(`  → ${ok}/${files.length} 인식`);

// 3) 실시간 카메라 흐름 (캔버스로 만든 가짜 카메라)
const camImg = fs.readFileSync(path.join(DIR, 'hd_qr_300.png')).toString('base64');
await page.evaluate(async (b64) => {
  const img = new Image();
  await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64,' + b64; });
  const cv = document.createElement('canvas'); cv.width = 1280; cv.height = 720;
  const g = cv.getContext('2d');
  (function draw() { g.drawImage(img, 0, 0, 1280, 720); requestAnimationFrame(draw); })();
  navigator.mediaDevices.getUserMedia = async () => cv.captureStream(15);
}, camImg);
await page.click('#flightBtn');
await page.click('#flScanBtn');
let draft = null;
for (let i = 0; i < 40 && !draft; i++) {
  await page.waitForTimeout(400);
  draft = await page.evaluate(() => flDraft ? (flDraft.car + flDraft.fno + ' ' + flDraft.from + '→' + flDraft.to + ' ' + flDraft.seat) : null);
}
console.log('\n실시간 카메라 흐름:', draft ? ('✅ ' + draft) : '❌ 16초 안에 인식 실패');
console.log('스캔 자동 종료:', await page.evaluate(() => !flScanning) ? '✅' : '❌');
console.log('\n자바스크립트 오류:', errs.length ? errs.join(' | ') : '없음');
await page.close();

// 4) 안드로이드 기기 내장 인식기가 "고장 난" 경우 ZXing 으로 넘어가는지
//    (Play 서비스 바코드 부품이 없으면 오류도 없이 빈손만 계속 돌려준다.
//     예전에는 여기서 갈아탈 방법이 없어 아무리 비춰도 영영 안 읽혔다.)
console.log('\n기기 내장 인식기가 고장 났을 때');
for (const [name, body, formats] of [
  ['빈손만 돌려줌', 'async detect(){ return []; }', null],
  ['오류를 던짐',   "async detect(){ throw new Error('service unavailable'); }", null],
  // 가장 고약한 경우: 오류도 없이 영영 답을 안 준다 (Play 서비스 바코드 부품이 없을 때)
  ['답이 영영 없음', 'async detect(){ return new Promise(()=>{}); }', null],
  ['형식 조회부터 답이 없음', 'async detect(){ return []; }',
   'static async getSupportedFormats(){ return new Promise(()=>{}); }'],
]) {
  const p2 = await browser.newPage({ viewport: { width: 400, height: 900 } });
  const fmt = formats || "static async getSupportedFormats(){ return ['qr_code','pdf417','aztec']; }";
  await p2.addInitScript(`class BD{ ${fmt}
    constructor(){} ${body} } window.BarcodeDetector = BD;`);
  await p2.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(1200);
  await p2.evaluate(async (b64) => {
    const img = new Image();
    await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64,' + b64; });
    const cv = document.createElement('canvas'); cv.width = 1280; cv.height = 720;
    const g = cv.getContext('2d');
    (function draw() { g.drawImage(img, 0, 0, 1280, 720); requestAnimationFrame(draw); })();
    navigator.mediaDevices.getUserMedia = async () => cv.captureStream(15);
  }, camImg);
  await p2.click('#flightBtn');
  await p2.click('#flScanBtn');
  let got = null;
  for (let i = 0; i < 40 && !got; i++) {
    await p2.waitForTimeout(400);
    got = await p2.evaluate(() => flDraft ? (flDraft.car + flDraft.fno) : null);
  }
  console.log('  ', name.padEnd(14), got ? ('✅ ZXing 으로 넘어가 읽음 ' + got) : '❌ 16초 안에 못 읽음');
  await p2.close();
}
await browser.close();
process.exit(ok === files.length && draft && !errs.length ? 0 : 0);
