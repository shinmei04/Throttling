const puppeteer = require('puppeteer');
const fs = require('fs');

// tc 側で帯域制御する前提の通常遷移計測
// - PROFILE_NAME: ネットワークプロファイル名（CSVラベル）
// - MODE: prefail 固定（ラベル用途のみ。prerenderはWeb側で仕込む）
// - TRIAL_COUNT: 試行回数（default 100）
// - WAIT_TIME_MS: Home 滞在時間（default 2000ms）
// - CSV に Network ログ (prerender/main/canceled) を JSON 文字列で格納

const PROFILE_NAME = process.env.PROFILE_NAME || 'tc_profile';
const MODE = 'prefail';
const TRIAL_COUNT = Number.parseInt(process.env.TRIAL_COUNT || '100', 10);
const WAIT_TIME_MS = Number.parseInt(process.env.WAIT_TIME_MS || '2000', 10);
const OUTPUT_FILE = process.env.OUTPUT_FILE || 'log.csv';
const SKIP_THRESHOLD = 5;
const TRIAL_TIMEOUT_MS = 120000;
const PRERENDER_LIKE_DOMAINS = [
    'https://victim.lab-ish.com/',
    'https://attack.lab-ish.com/'
];

const TARGETS = [
    { name: 'Light',  url: 'https://victim.lab-ish.com/', id: '#link-light' },
    { name: 'Medium', url: 'https://depth.lab-ish.com/', id: '#link-medium' },
    { name: 'Heavy',  url: 'https://attack.lab-ish.com/', id: '#link-heavy' }
];

// TARGETS を環境変数やCLI引数で絞り込み（例: TARGETS=Light,Heavy あるいは CLI `node Premeasure_tc_prefail.js Light Heavy`）
const targetsToMeasure = (() => {
    const cliArgs = process.argv.slice(2).filter(Boolean);
    const raw = cliArgs.length ? cliArgs.join(',') : (process.env.TARGETS || process.env.TARGET || '');
    if (!raw.trim()) return TARGETS;
    const set = new Set(
        raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    );
    const filtered = TARGETS.filter((t) => set.has(t.name.toLowerCase()));
    return filtered.length ? filtered : TARGETS;
})();

const applyThrottle = async (page) => {
    if (!page) return;
    await page.setCacheEnabled(false);
};

const toCsvValue = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return value;
    return `"${String(value).replace(/"/g, '""')}"`;
};

(async () => {
    fs.writeFileSync(OUTPUT_FILE, 'profile,mode,target,trial,LCP_ms,FCP_ms,successCount,canceledCount,resources\n');

    const browser = await puppeteer.launch({
        headless: "new",
        ignoreHTTPSErrors: true,
        args: [
            '--ignore-certificate-errors',
            '--enable-features=SpeculationRules,Prerender2'
        ]
    });

    console.log(`=== tc帯域制御 前提計測開始 ===`);
    console.log(`profile=${PROFILE_NAME}, mode=${MODE}, trials=${TRIAL_COUNT}, wait=${WAIT_TIME_MS}ms`);
    console.log(`出力: ${OUTPUT_FILE}\n`);

    let currentTrialContext = null;
    for (const target of targetsToMeasure) {
        console.log(`[${PROFILE_NAME}] - ${target.name} 測定中...`);
        let consecutiveFailures = 0;

        for (let i = 1; i <= TRIAL_COUNT; i++) {
            if (consecutiveFailures >= SKIP_THRESHOLD) {
                console.log(`\n   ⚠️  ${SKIP_THRESHOLD}回連続失敗のため残りをTimeOutとします。`);
                for (let k = i; k <= TRIAL_COUNT; k++) {
                    const csvLine = [
                        PROFILE_NAME,
                        MODE,
                        target.name,
                        k,
                        'Timeout',
                        'Timeout',
                        0,
                        0,
                        toCsvValue(JSON.stringify([]))
                    ].join(',') + '\n';
                    fs.appendFileSync(OUTPUT_FILE, csvLine);
                }
                break;
            }

            const page = await browser.newPage();
            await page.setViewport({ width: 1280, height: 20000 });
            await applyThrottle(page);

            currentTrialContext = {
                profile: PROFILE_NAME,
                mode: MODE,
                target: target.name,
                trial: i,
                LCP_ms: null,
                FCP_ms: null,
                resources: [],
                cleanups: []
            };

            const session = await page.target().createCDPSession();
            await session.send('Network.enable');
            const reqIdToResource = new Map();

            const isTargetUrl = (url = '') => PRERENDER_LIKE_DOMAINS.some((base) => url.startsWith(base));

            const handleRequestWillBeSent = (params) => {
                const url = params.request?.url || '';
                if (!isTargetUrl(url)) return;
                const res = {
                    requestId: params.requestId,
                    url,
                    type: params.type || '',
                    status: 'pending',
                    errorText: null,
                    encodedDataLength: null
                };
                currentTrialContext.resources.push(res);
                reqIdToResource.set(params.requestId, res);
            };

            const handleLoadingFailed = (params) => {
                const res = reqIdToResource.get(params.requestId);
                if (!res) return;
                if (!params.canceled) return;
                res.status = 'canceled';
                res.errorText = params.errorText || null;
            };

            const handleLoadingFinished = (params) => {
                const res = reqIdToResource.get(params.requestId);
                if (!res) return;
                if (res.status === 'canceled') return;
                res.status = 'success';
                res.encodedDataLength = params.encodedDataLength ?? null;
            };

            session.on('Network.requestWillBeSent', handleRequestWillBeSent);
            session.on('Network.loadingFailed', handleLoadingFailed);
            session.on('Network.loadingFinished', handleLoadingFinished);

            currentTrialContext.cleanups.push(async () => {
                const off = session.off?.bind(session) || session.removeListener?.bind(session);
                off?.('Network.requestWillBeSent', handleRequestWillBeSent);
                off?.('Network.loadingFailed', handleLoadingFailed);
                off?.('Network.loadingFinished', handleLoadingFinished);
            });

            let timeoutId;
            const trialTimeout = new Promise((_, rej) => {
                timeoutId = setTimeout(() => rej(new Error('Trial timeout')), TRIAL_TIMEOUT_MS);
            });

            try {
                const result = await Promise.race([
                    (async () => {
                        await page.goto('https://home.lab-ish.com/index.html', { waitUntil: 'networkidle0', timeout: TRIAL_TIMEOUT_MS });

                        await new Promise((r) => setTimeout(r, WAIT_TIME_MS));

                        await Promise.all([
                            page.waitForNavigation({ waitUntil: 'load', timeout: TRIAL_TIMEOUT_MS }),
                            page.click(target.id)
                        ]);

                        const metrics = await page.evaluate(async () => {
                            const getLCP = () => new Promise((resolve) => {
                                new PerformanceObserver((list) => resolve(list.getEntries().pop())).observe({ type: 'largest-contentful-paint', buffered: true });
                                setTimeout(() => resolve(null), 5000);
                            });

                            const [nav] = performance.getEntriesByType('navigation');
                            const [fcp] = performance.getEntriesByName('first-contentful-paint');
                            const lcpEntry = await getLCP();

                            const actStart = nav.activationStart || 0;
                            const lcp = lcpEntry ? lcpEntry.startTime : 0;
                            const fcpTime = fcp ? fcp.startTime : 0;

                            return {
                                lcp: Math.max(0, lcp - actStart),
                                fcp: Math.max(0, fcpTime - actStart)
                            };
                        });

                        return {
                            fcp: metrics.fcp,
                            lcp: metrics.lcp
                        };
                    })(),
                    trialTimeout
                ]);

                clearTimeout(timeoutId);

                currentTrialContext.FCP_ms = Number.isFinite(result.fcp) ? result.fcp : null;
                currentTrialContext.LCP_ms = Number.isFinite(result.lcp) ? result.lcp : null;
                const all = currentTrialContext.resources;
                const numSuccess = all.filter((r) => r.status === 'success').length;
                const numCanceled = all.filter((r) => r.status === 'canceled').length;

                const csvLine = [
                    currentTrialContext.profile,
                    currentTrialContext.mode,
                    currentTrialContext.target,
                    currentTrialContext.trial,
                    currentTrialContext.LCP_ms !== null ? currentTrialContext.LCP_ms.toFixed(2) : '',
                    currentTrialContext.FCP_ms !== null ? currentTrialContext.FCP_ms.toFixed(2) : '',
                    numSuccess,
                    numCanceled,
                    toCsvValue(JSON.stringify(all))
                ].join(',') + '\n';

                fs.appendFileSync(OUTPUT_FILE, csvLine);
                consecutiveFailures = 0;
                process.stdout.write(`.`);

            } catch (e) {
                clearTimeout(timeoutId);
                consecutiveFailures++;
                console.error(`\n[Error] Trial ${i}: ${e.message}`);

                const csvLine = [
                    currentTrialContext.profile,
                    currentTrialContext.mode,
                    currentTrialContext.target,
                    currentTrialContext.trial,
                    'Timeout',
                    'Timeout',
                    currentTrialContext.resources.filter((r) => r.status === 'success').length,
                    currentTrialContext.resources.filter((r) => r.status === 'canceled').length,
                    toCsvValue(JSON.stringify(currentTrialContext.resources))
                ].join(',') + '\n';
                fs.appendFileSync(OUTPUT_FILE, csvLine);
            } finally {
                await Promise.all(currentTrialContext.cleanups.map(async (fn) => fn && fn()));
                currentTrialContext = null;
                await page.close();
            }
        }
        console.log(" 完了");
    }

    console.log(`\n=== 全計測終了 ===`);
    await browser.close();
})();
