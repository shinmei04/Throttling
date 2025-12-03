const puppeteer = require('puppeteer');
const fs = require('fs');

// ==========================================
// 実験設定 (CPUスロットリング多段版)
// ==========================================
const TRIAL_COUNT = 30; // 計測回数
const OUTPUT_FILE = 'raw_prerender_cpu_multi.csv'; // 保存ファイル名
const SKIP_THRESHOLD = 5; // 5回連続失敗でスキップ
const WAIT_TIME = 1000; // Homeでの滞在時間 (ms)
const CPU_RATES = [1, 2, 4, 8]; // 1=無効, 2/4/8で低スペック端末を再現

const TARGETS = [
    { name: 'Light',  url: 'https://victim.lab-ish.com/', id: '#link-light' },
    { name: 'Medium', url: 'https://depth.lab-ish.com/', id: '#link-medium' },
    { name: 'Heavy',  url: 'https://attack.lab-ish.com/', id: '#link-heavy' }
];

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
    const applyThrottle = async (page, conditions, cpuRate) => {
        if (!page) return;
        await page.setCacheEnabled(false);

        const client = await page.target().createCDPSession();
        await client.send('Network.enable');

        if (cpuRate && cpuRate > 1) {
            await client.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
        } else {
            // rate=1 のときはスロットリングをオフにする
            await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        }

        if (conditions) {
            await client.send('Network.emulateNetworkConditions', {
                offline: false,
                downloadThroughput: conditions.download,
                uploadThroughput: conditions.upload,
                latency: conditions.latency
            });
        }
    };

    fs.writeFileSync(OUTPUT_FILE, 'Condition,CpuRate,Page,Trial_No,LCP_ms,FCP_ms,Transfer_MB,Prerendered\n');

    const browser = await puppeteer.launch({
        headless: "new",
        ignoreHTTPSErrors: true,
        args: ['--ignore-certificate-errors']
    });

    console.log(`=== CPUスロットリング多段 Prerender実験開始: ${TRIAL_COUNT}回計測/条件 (Wait: ${WAIT_TIME}ms) ===`);
    console.log(`CPU rates: ${CPU_RATES.join(', ')} | 出力: ${OUTPUT_FILE}\n`);

    for (const cpuRate of CPU_RATES) {
        for (const [conditionName, conditions] of Object.entries(NETWORK_CONDITIONS)) {
            for (const target of TARGETS) {

                console.log(`[CPU x${cpuRate}] [${conditionName}] - ${target.name} 測定中...`);
                let consecutiveFailures = 0;

                const handleTargetCreated = async (targetObj) => {
                    if (targetObj.type() !== 'page') return;
                    const newPage = await targetObj.page();
                    await applyThrottle(newPage, conditions, cpuRate);
                };
                browser.on('targetcreated', handleTargetCreated);

                for (let i = 1; i <= TRIAL_COUNT; i++) {
                    if (consecutiveFailures >= SKIP_THRESHOLD) {
                        console.log(`\n   ⚠️  ${SKIP_THRESHOLD}回連続失敗のため残りをTimeOutとします。`);
                        for (let k = i; k <= TRIAL_COUNT; k++) {
                            const skipLine = `${conditionName},${cpuRate},${target.name},${k},TimeOut,TimeOut,0,FALSE\n`;
                            fs.appendFileSync(OUTPUT_FILE, skipLine);
                        }
                        break;
                    }

                    const page = await browser.newPage();
                    await page.setViewport({ width: 1280, height: 20000 });
                    await applyThrottle(page, conditions, cpuRate);

                    try {
                        await page.goto('https://home.lab-ish.com/index.html', { waitUntil: 'networkidle0', timeout: 60000 });
                    } catch (e) {
                        await page.close();
                        consecutiveFailures++;
                        console.error(`\n[Home Load Error] Trial ${i}: ${e.message}`);
                        const errorLine = `${conditionName},${cpuRate},${target.name},${i},TimeOut,TimeOut,0,FALSE\n`;
                        fs.appendFileSync(OUTPUT_FILE, errorLine);
                        process.stdout.write(`x`);
                        continue;
                    }

                    await new Promise(r => setTimeout(r, WAIT_TIME));

                    try {
                        const [response] = await Promise.all([
                            page.waitForNavigation({ waitUntil: 'load', timeout: 120000 }),
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

                        const csvLine = `${conditionName},${cpuRate},${target.name},${i},${metrics.lcp.toFixed(2)},${metrics.fcp.toFixed(2)},${(metrics.size/1024/1024).toFixed(2)},${metrics.isPrerender}\n`;
                        fs.appendFileSync(OUTPUT_FILE, csvLine);
                        
                        consecutiveFailures = 0;
                        process.stdout.write(`.`);

                    } catch (e) {
                        consecutiveFailures++;
                        console.error(`\n[Error] Trial ${i}: ${e.message}`);
                        const errorLine = `${conditionName},${cpuRate},${target.name},${i},TimeOut,TimeOut,0,FALSE\n`;
                        fs.appendFileSync(OUTPUT_FILE, errorLine);
                    } finally {
                        await page.close();
                    }
                }
                browser.off('targetcreated', handleTargetCreated);
                console.log(" 完了");
            }
        }
    }

    console.log(`\n=== 全計測終了 ===`);
    await browser.close();
})();
