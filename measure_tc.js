const puppeteer = require('puppeteer');
const fs = require('fs');

// ==========================================
// tc で帯域を制御する前提の通常遷移計測スクリプト
// - DevTools のネットワークエミュレーションは使わない
// - Home から各ページへクリック遷移して計測
// ==========================================

const TRIAL_COUNT = 30; // 計測回数
const OUTPUT_FILE = 'raw_normal_tc_slow3g.csv'; // 出力先
const WAIT_TIME = 2000; // Homeでの待機時間(ms)。必要なら調整

const TARGETS = [
    { name: 'Light', url: 'https://victim.lab-ish.com/', id: '#link-light' },
    { name: 'Medium', url: 'https://depth.lab-ish.com/', id: '#link-medium' },
    { name: 'Heavy', url: 'https://attack.lab-ish.com/', id: '#link-heavy' }
];

// tc 側で帯域を制御する前提。Condition はラベル用途のみ（環境変数で上書き可）。
const CONDITION_NAME = process.env.CONDITION_NAME || 'tc_profile';

(async () => {
    const applyThrottle = async (page) => {
        if (!page) return;
        await page.setCacheEnabled(false);
    };

    fs.writeFileSync(OUTPUT_FILE, 'Condition,Page,Trial_No,LCP_ms,FCP_ms,Transfer_MB,Prerendered\n');

    const browser = await puppeteer.launch({
        headless: "new",
        ignoreHTTPSErrors: true,
        args: ['--ignore-certificate-errors']
    });

    console.log(`=== tc 前提の通常遷移計測開始: ${TRIAL_COUNT}回計測 (Condition=${CONDITION_NAME}) ===`);

    for (const target of TARGETS) {
        console.log(`[${CONDITION_NAME}] - ${target.name} 測定中...`);

        for (let i = 1; i <= TRIAL_COUNT; i++) {
            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 20000 });
            await applyThrottle(page);

            try {
                // Home 表示
                await page.goto('https://home.lab-ish.com/index.html', { waitUntil: 'networkidle0', timeout: 120000 });
                if (WAIT_TIME > 0) await new Promise(r => setTimeout(r, WAIT_TIME));

                // クリック遷移（Prerender 無効前提で通常遷移）
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'load', timeout: 120000 }),
                    page.click(target.id)
                ]);

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

                const csvLine = `${CONDITION_NAME},${target.name},${i},${metrics.lcp.toFixed(2)},${metrics.fcp.toFixed(2)},${(metrics.size / 1024 / 1024).toFixed(2)},${metrics.isPrerender}\n`;
                fs.appendFileSync(OUTPUT_FILE, csvLine);
                process.stdout.write(`.`);

            } catch (e) {
                console.error(`\n[Error] Trial ${i}: ${e.message}`);
                fs.appendFileSync(OUTPUT_FILE, `${CONDITION_NAME},${target.name},${i},Timeout,Timeout,0,FALSE\n`);
            } finally {
                await page.close();
            }
        }
        console.log(" 完了");
    }

    console.log(`\n=== 全計測終了 ===`);
    await browser.close();
})();
