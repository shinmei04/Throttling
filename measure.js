const puppeteer = require('puppeteer');
const fs = require('fs');

// ==========================================
// 実験設定
// ==========================================
const TRIAL_COUNT = 30; // 計測回数
const OUTPUT_FILE = 'raw_data.csv'; // 保存ファイル名

const TARGET_URLS = [
    { name: 'Light', url: 'https://victim.lab-ish.com' },
    { name: 'Medium', url: 'https://depth.lab-ish.com' },
    { name: 'Heavy', url: 'https://attack.lab-ish.com' }
];

// 実測RTT 9ms をベースにした設定
const NETWORK_CONDITIONS = {
    'vanilla':null,

    // ■ 追加: Fast 4G (キャリアアグリゲーション/混雑していないLTE)
    'Fast 4G': {
        download: 100 * 1024 * 1024 / 8, // 100 Mbps
        upload: 50 * 1024 * 1024 / 8,
        latency: 20                       
    },

    // 標準的な4G
    'Regular 4G': {
        download: 30 * 1024 * 1024 / 8,
        upload: 15 * 1024 * 1024 / 8,
        latency: 20
    },

    // 既存: 3G
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
    // 1. CSVファイルの初期化（ヘッダー書き込み）
    fs.writeFileSync(OUTPUT_FILE, 'Condition,Page,Trial_No,LCP_ms,FCP_ms,Transfer_MB,Prerendered\n');

    // 2. ブラウザ起動
    const browser = await puppeteer.launch({
        headless: "new", // 100回だと長いので画面なし(new)推奨。
        ignoreHTTPSErrors: true,
        args: ['--ignore-certificate-errors']
    });

    console.log(`=== 実験開始: ${TRIAL_COUNT}回計測 ===`);
    console.log(`条件数: ${Object.keys(NETWORK_CONDITIONS).length} (5G/Fast4G含む)`);
    console.log(`データは ${OUTPUT_FILE} に順次書き込まれます...\n`);

    // 3. 計測ループ
    for (const [conditionName, conditions] of Object.entries(NETWORK_CONDITIONS)) {
        for (const target of TARGET_URLS) {

            console.log(`[${conditionName}] - ${target.name} 測定中...`);

            for (let i = 1; i <= TRIAL_COUNT; i++) {
                const page = await browser.newPage();

                // Heavyページ読み込み漏れ対策 (縦長画面)
                await page.setViewport({ width: 1280, height: 20000 });

                if (conditions) await page.emulateNetworkConditions(conditions);
                await page.setCacheEnabled(false);

                try {
                    // アクセス (タイムアウト120秒)
                    await page.goto(target.url, { waitUntil: 'networkidle0', timeout: 120000 });

                    // 指標取得
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
                            lcp: Math.max(0, lcp - actStart),
                            fcp: Math.max(0, fcpTime - actStart),
                            size: (nav.transferSize || 0) + resSize,
                            isPrerender: actStart > 0
                        };
                    });

                    // CSV形式に整形して書き込み
                    const csvLine = `${conditionName},${target.name},${i},${metrics.lcp.toFixed(2)},${metrics.fcp.toFixed(2)},${(metrics.size / 1024 / 1024).toFixed(2)},${metrics.isPrerender}\n`;
                    fs.appendFileSync(OUTPUT_FILE, csvLine);

                    // 進捗表示
                    process.stdout.write(`.`);

                } catch (e) {
                    console.error(`\n[Error] Trial ${i}: ${e.message}`);
                    fs.appendFileSync(OUTPUT_FILE, `${conditionName},${target.name},${i},Timeout,Timeout,0,FALSE\n`);
                } finally {
                    await page.close();
                }
            }
            console.log(" 完了");
        }
    }

    console.log(`\n=== 全計測終了 ===`);
    await browser.close();
})();