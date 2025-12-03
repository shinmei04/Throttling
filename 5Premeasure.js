const puppeteer = require('puppeteer');
const fs = require('fs');

// ==========================================
// 実験設定 (ベースラインと統一)
// ==========================================
const TRIAL_COUNT = 30; // 計測回数
const OUTPUT_FILE = 'raw_prerender5000_data.csv'; // 保存ファイル名
const SKIP_THRESHOLD = 5; // 5回連続失敗でスキップ

// 検証したい待ち時間 (今回は固定で実験する場合の例。必要ならここを変えて実行してください)
const WAIT_TIME = 5000; // 例: 5秒待機

const TARGETS = [
    { name: 'Light',  url: 'https://victim.lab-ish.com/', id: '#link-light' },
    { name: 'Medium', url: 'https://depth.lab-ish.com/', id: '#link-medium' },
    { name: 'Heavy',  url: 'https://attack.lab-ish.com/', id: '#link-heavy' }
];

// 通信環境 (30measure.js と完全に一致)
const NETWORK_CONDITIONS = {
    'vanilla': null,
    'Fast 4G': {
        download: 100 * 1024 * 1024 / 8,
        upload: 50 * 1024 * 1024 / 8,
        latency: 5
    },
    'Regular 4G': {
        download: 30 * 1024 * 1024 / 8,
        upload: 15 * 1024 * 1024 / 8,
        latency: 20
    },
    'Fast 3G': {
        download: 1.5 * 1024 * 1024 / 8,
        upload: 750 * 1024 / 8,
        latency: 20
    },
    'Slow 3G': {
        download: 400 * 1024 / 8,
        upload: 100 * 1024 / 8,
        latency: 20
    }
};

(async () => {
    const applyThrottle = async (page, conditions) => {
        if (!page) return;
        await page.setCacheEnabled(false);
        if (!conditions) return;

        const client = await page.target().createCDPSession();
        await client.send('Network.enable');
        await client.send('Network.emulateNetworkConditions', {
            offline: false,
            downloadThroughput: conditions.download,
            uploadThroughput: conditions.upload,
            latency: conditions.latency
        });
    };

    // 1. CSVヘッダー初期化 (30measure.js と同じカラム構成)
    fs.writeFileSync(OUTPUT_FILE, 'Condition,Page,Trial_No,LCP_ms,FCP_ms,Transfer_MB,Prerendered\n');

    const browser = await puppeteer.launch({
        headless: "new",
        ignoreHTTPSErrors: true,
        args: ['--ignore-certificate-errors']
    });

    console.log(`=== Prerendering実験開始: ${TRIAL_COUNT}回計測 (Wait: ${WAIT_TIME}ms) ===`);
    console.log(`データは ${OUTPUT_FILE} に順次書き込まれます...\n`);

    for (const [conditionName, conditions] of Object.entries(NETWORK_CONDITIONS)) {
        for (const target of TARGETS) {

            console.log(`[${conditionName}] - ${target.name} 測定中...`);
            let consecutiveFailures = 0;

            const handleTargetCreated = async (targetObj) => {
                if (targetObj.type() !== 'page') return;
                const newPage = await targetObj.page();
                await applyThrottle(newPage, conditions);
            };
            browser.on('targetcreated', handleTargetCreated);

            for (let i = 1; i <= TRIAL_COUNT; i++) {
                
                // スキップ判定
                if (consecutiveFailures >= SKIP_THRESHOLD) {
                    console.log(`\n   ⚠️  ${SKIP_THRESHOLD}回連続失敗のため残りをTimeOutとします。`);
                    for (let k = i; k <= TRIAL_COUNT; k++) {
                        // TimeOut時の出力形式も合わせる
                        const skipLine = `${conditionName},${target.name},${k},TimeOut,TimeOut,0,FALSE\n`;
                        fs.appendFileSync(OUTPUT_FILE, skipLine);
                    }
                    break;
                }

                const page = await browser.newPage();
                // 縦長画面設定
                await page.setViewport({ width: 1280, height: 20000 });
                await applyThrottle(page, conditions);

                // 1. Homeへアクセス (制限下でアクセス)
                try {
                    await page.goto('https://home.lab-ish.com/index.html', { waitUntil: 'networkidle0', timeout: 120000 });
                } catch (e) {
                    await page.close();
                    consecutiveFailures++;
                    console.error(`\n[Home Load Error] Trial ${i}: ${e.message}`);
                    const errorLine = `${conditionName},${target.name},${i},TimeOut,TimeOut,0,FALSE\n`;
                    fs.appendFileSync(OUTPUT_FILE, errorLine);
                    process.stdout.write(`x`);
                    continue;
                }

                // 2. ユーザーの滞在時間 (裏読みタイム)
                await new Promise(r => setTimeout(r, WAIT_TIME));

                try {
                    // 3. クリック計測
                    const [response] = await Promise.all([
                        page.waitForNavigation({ waitUntil: 'load', timeout: 120000 }),
                        page.click(target.id)
                    ]);

                    // 4. 指標取得 
                    const metrics = await page.evaluate(async () => {
                        const getLCP = () => new Promise(r => {
                            new PerformanceObserver((l) => r(l.getEntries().pop())).observe({ type: 'largest-contentful-paint', buffered: true });
                            setTimeout(() => r(null), 5000);
                        });
                        
                        const [nav] = performance.getEntriesByType('navigation');
                        const [fcp] = performance.getEntriesByName('first-contentful-paint');
                        const lcpEntry = await getLCP();
                        const resources = performance.getEntriesByType('resource');
                        const resSize = resources.reduce((sum, r) => sum + r.transferSize, 0);

                        const actStart = nav.activationStart || 0;
                        const lcp = lcpEntry ? lcpEntry.startTime : 0;
                        const fcpTime = fcp ? fcp.startTime : 0;

                        return {
                            // クリック時刻(actStart)を引くことで「0秒表示」を判定
                            lcp: Math.max(0, lcp - actStart),
                            fcp: Math.max(0, fcpTime - actStart),
                            size: (nav.transferSize || 0) + resSize, // 転送量も含める
                            isPrerender: actStart > 0
                        };
                    });

                    // CSV書き込み (30measure.jsと同じカラム順序)
                    const csvLine = `${conditionName},${target.name},${i},${metrics.lcp.toFixed(2)},${metrics.fcp.toFixed(2)},${(metrics.size/1024/1024).toFixed(2)},${metrics.isPrerender}\n`;
                    fs.appendFileSync(OUTPUT_FILE, csvLine);
                    
                    consecutiveFailures = 0;
                    process.stdout.write(`.`);

                } catch (e) {
                    consecutiveFailures++;
                    console.error(`\n[Error] Trial ${i}: ${e.message}`);
                    const errorLine = `${conditionName},${target.name},${i},TimeOut,TimeOut,0,FALSE\n`;
                    fs.appendFileSync(OUTPUT_FILE, errorLine);
                } finally {
                    await page.close();
                }
            }
            browser.off('targetcreated', handleTargetCreated);
            console.log(" 完了");
        }
    }

    console.log(`\n=== 全計測終了 ===`);
    await browser.close();
})();
