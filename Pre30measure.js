const puppeteer = require('puppeteer');
const fs = require('fs');

// ==========================================
// 実験設定 (30measure.js と条件を合わせる)
// ==========================================
const TRIAL_COUNT = 30; // 30回計測
const OUTPUT_FILE = 'experiment_prerender_data.csv'; // 出力ファイル名
const SKIP_THRESHOLD = 5; // 5回連続失敗でスキップ

// 検証したい待ち時間 (ミリ秒)
// Prerenderが完了するまでの「猶予時間」として機能します
const WAIT_TIMES = [500, 2000, 5000]; 

// クリック対象 (IDはHomeのHTMLに合わせています)
const TARGETS = [
    { name: 'Light',  url: 'https://victim.lab-ish.com/', id: '#link-light' },
    { name: 'Medium', url: 'https://depth.lab-ish.com/', id: '#link-medium' },
    { name: 'Heavy',  url: 'https://attack.lab-ish.com/', id: '#link-heavy' }
];

// ★通信環境 (30measure.js と完全に一致させる)
const NETWORK_CONDITIONS = {
    '5G':         { download: 500 * 1024 * 1024 / 8, upload: 100 * 1024 * 1024 / 8, latency: 0 },
    'Fast 4G':    { download: 100 * 1024 * 1024 / 8, upload: 50 * 1024 * 1024 / 8,  latency: 5 },
    'Regular 4G': { download: 30 * 1024 * 1024 / 8,  upload: 15 * 1024 * 1024 / 8,  latency: 20 },
    'Fast 3G':    { download: 1.5 * 1024 * 1024 / 8, upload: 750 * 1024 / 8,      latency: 20 },
    'Slow 3G':    { download: 400 * 1024 / 8,    upload: 100 * 1024 / 8,      latency: 20 }
};

(async () => {
    // CSVヘッダー (Wait_ms列を追加)
    fs.writeFileSync(OUTPUT_FILE, 'Condition,Wait_ms,Page,Trial_No,LCP_ms,FCP_ms,Prerendered\n');

    const browser = await puppeteer.launch({ 
        headless: "new", 
        ignoreHTTPSErrors: true,
        args: ['--ignore-certificate-errors'] 
    });

    console.log(`=== Prerendering実験 (待機時間変動): ${TRIAL_COUNT}回計測 ===`);
    console.log(`待ち時間: ${WAIT_TIMES.join('ms, ')}ms`);
    console.log(`条件数: ${Object.keys(NETWORK_CONDITIONS).length} | スキップ閾値: ${SKIP_THRESHOLD}回`);
    console.log(`データは ${OUTPUT_FILE} に保存されます...\n`);

    for (const [conditionName, conditions] of Object.entries(NETWORK_CONDITIONS)) {
        for (const waitTime of WAIT_TIMES) {
            for (const target of TARGETS) {
                
                console.log(`[${conditionName}] Wait:${waitTime}ms - ${target.name} 測定中...`);
                let consecutiveFailures = 0;

                for (let i = 1; i <= TRIAL_COUNT; i++) {
                    
                    // スキップ判定
                    if (consecutiveFailures >= SKIP_THRESHOLD) {
                        console.log(`\n   ⚠️  ${SKIP_THRESHOLD}回連続失敗のため、残り(${i}〜${TRIAL_COUNT}回目)をTimeOutとして埋めます。`);
                        for (let k = i; k <= TRIAL_COUNT; k++) {
                            const skipLine = `${conditionName},${waitTime},${target.name},${k},TimeOut,TimeOut,FALSE\n`;
                            fs.appendFileSync(OUTPUT_FILE, skipLine);
                        }
                        break;
                    }

                    const page = await browser.newPage();
                    // 縦長画面設定 (Heavy画像の読み込み漏れ防止)
                    await page.setViewport({ width: 1280, height: 20000 });

                    // 1. Homeへアクセス (ここは高速回線で行う想定なので制限なし)
                    // ※Homeが開けないと実験にならないので再試行処理を入れています
                    try {
                        await page.goto('https://home.lab-ish.com/index.html', { waitUntil: 'networkidle0' });
                    } catch (e) {
                        await page.close();
                        i--; // カウントを進めずにリトライ
                        continue;
                    }

                    // 2. 帯域制限を適用 (ここから裏読みがこの速度で行われる)
                    if (conditions) await page.emulateNetworkConditions(conditions);

                    // 3. ユーザーの滞在時間 (裏読みタイム)
                    await new Promise(r => setTimeout(r, waitTime));

                    try {
                        // 4. クリック計測
                        const [response] = await Promise.all([
                            page.waitForNavigation({ waitUntil: 'load', timeout: 120000 }),
                            page.click(target.id)
                        ]);

                        const metrics = await page.evaluate(async () => {
                            // LCP計測
                            const getLCP = () => new Promise(r => {
                                new PerformanceObserver((l) => r(l.getEntries().pop())).observe({ type: 'largest-contentful-paint', buffered: true });
                                setTimeout(() => r(null), 3000);
                            });
                            
                            const [nav] = performance.getEntriesByType('navigation');
                            const [fcp] = performance.getEntriesByName('first-contentful-paint');
                            const lcpEntry = await getLCP();

                            const actStart = nav.activationStart || 0;
                            const lcp = lcpEntry ? lcpEntry.startTime : 0;
                            const fcpTime = fcp ? fcp.startTime : 0;

                            return {
                                // クリック時刻(activationStart)を引くことで「0秒表示」を判定
                                // Prerender成功時はここがほぼ0になる
                                lcp: Math.max(0, lcp - actStart),
                                fcp: Math.max(0, fcpTime - actStart),
                                isPrerender: actStart > 0
                            };
                        });

                        // CSV書き込み
                        const csvLine = `${conditionName},${waitTime},${target.name},${i},${metrics.lcp.toFixed(2)},${metrics.fcp.toFixed(2)},${metrics.isPrerender}\n`;
                        fs.appendFileSync(OUTPUT_FILE, csvLine);
                        
                        consecutiveFailures = 0; // 成功したらリセット
                        process.stdout.write(`.`);

                    } catch (e) {
                        console.log(`\n[ERROR] ${e.message}`);
                        consecutiveFailures++;
                        // エラーも記録
                        const errorLine = `${conditionName},${waitTime},${target.name},${i},TimeOut,TimeOut,FALSE\n`;
                        fs.appendFileSync(OUTPUT_FILE, errorLine);
                        process.stdout.write(`x`);
                    } finally {
                        await page.close();
                    }
                }
                console.log(" 完了");
            }
        }
    }

    console.log(`\n=== 全計測終了 ===`);
    await browser.close();
})();