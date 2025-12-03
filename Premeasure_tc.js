const puppeteer = require('puppeteer');
const fs = require('fs');

// ==========================================
// tc コマンドで帯域を制御する前提の計測スクリプト
// - ネットワークエミュレーションは使わず、キャッシュ無効化のみ
// - Condition は tc プロファイル名のラベルとして使う
// ==========================================

const TRIAL_COUNT = 5; // 計測回数
const OUTPUT_FILE = 'raw_prerender_tc_data.csv'; // 保存ファイル名
const SKIP_THRESHOLD = 5; // 5回連続失敗でスキップ
const WAIT_TIME = 2000; // Home滞在時間 (ms)
const TRIAL_TIMEOUT_MS = 120000; // 1試行の上限時間

// 必要に応じてラベルを増やす（例: tc_slow3g, tc_fast4g など）
const NETWORK_CONDITIONS = {
    'tc_profile': null
};

const TARGETS = [
    { name: 'Light',  url: 'https://victim.lab-ish.com/', id: '#link-light' },
    { name: 'Medium', url: 'https://depth.lab-ish.com/', id: '#link-medium' },
    { name: 'Heavy',  url: 'https://attack.lab-ish.com/', id: '#link-heavy' }
];

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

    console.log(`=== tc帯域制御 前提の Prerender計測開始: ${TRIAL_COUNT}回計測 (Wait: ${WAIT_TIME}ms) ===`);
    console.log(`データは ${OUTPUT_FILE} に順次書き込まれます...\n`);

    for (const [conditionName] of Object.entries(NETWORK_CONDITIONS)) {
        for (const target of TARGETS) {

            console.log(`[${conditionName}] - ${target.name} 測定中...`);
            let consecutiveFailures = 0;

            const handleTargetCreated = async (targetObj) => {
                if (targetObj.type() !== 'page') return;
                const newPage = await targetObj.page();
                await applyThrottle(newPage);
            };
            browser.on('targetcreated', handleTargetCreated);

            for (let i = 1; i <= TRIAL_COUNT; i++) {
                if (consecutiveFailures >= SKIP_THRESHOLD) {
                    console.log(`\n   ⚠️  ${SKIP_THRESHOLD}回連続失敗のため残りをTimeOutとします。`);
                    for (let k = i; k <= TRIAL_COUNT; k++) {
                        const skipLine = `${conditionName},${target.name},${k},TimeOut,TimeOut,0,FALSE\n`;
                        fs.appendFileSync(OUTPUT_FILE, skipLine);
                    }
                    break;
                }

                const page = await browser.newPage();
                await page.setViewport({ width: 1280, height: 20000 });
                await applyThrottle(page);

                let timeoutId;
                const trialTimeout = new Promise((_, rej) => {
                    timeoutId = setTimeout(() => rej(new Error('Trial timeout')), TRIAL_TIMEOUT_MS);
                });

                try {
                    const metrics = await Promise.race([
                        (async () => {
                            await page.goto('https://home.lab-ish.com/index.html', { waitUntil: 'networkidle0', timeout: 120000 });

                            await new Promise(r => setTimeout(r, WAIT_TIME));

                            await Promise.all([
                                page.waitForNavigation({ waitUntil: 'load', timeout: TRIAL_TIMEOUT_MS }),
                                page.click(target.id)
                            ]);

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

                            return metrics;
                        })(),
                        trialTimeout
                    ]);

                    clearTimeout(timeoutId);

                    const csvLine = `${conditionName},${target.name},${i},${metrics.lcp.toFixed(2)},${metrics.fcp.toFixed(2)},${(metrics.size/1024/1024).toFixed(2)},${metrics.isPrerender}\n`;
                    fs.appendFileSync(OUTPUT_FILE, csvLine);

                    consecutiveFailures = 0;
                    process.stdout.write(`.`);

                } catch (e) {
                    clearTimeout(timeoutId);
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
