const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Prefail measurement focused on non-primary (non-navigated) sites.
// Primary site = the domain actually navigated via page.click().
// We only log Network events for other domains (possible prerender traffic).

const PROFILE_NAME = process.env.PROFILE_NAME || 'tc_profile';
const MODE = 'prefail-nonprimary';
const TRIAL_COUNT = Number.parseInt(process.env.TRIAL_COUNT || '50', 10);
const WAIT_TIME_MS = Number.parseInt(process.env.WAIT_TIME_MS || '2000', 10);
const POST_NAV_WAIT_MS = Number.parseInt(process.env.POST_NAV_WAIT_MS || '1500', 10); // wait after nav/metrics to let Network events settle
const OUTPUT_FILE = process.env.OUTPUT_FILE || 'raw.csv';
const SKIP_THRESHOLD = 5;
const TRIAL_TIMEOUT_MS = 120000;
const USER_DATA_DIR = path.join(process.cwd(), 'tmp-chrome-prefail-nonprimary');

const TARGETS = [
    { name: 'Light',  url: 'https://victim.lab-ish.com/', id: '#link-light', primaryDomain: 'https://victim.lab-ish.com/' },
    { name: 'Medium', url: 'https://depth.lab-ish.com/', id: '#link-medium', primaryDomain: 'https://depth.lab-ish.com/' },
    { name: 'Heavy',  url: 'https://attack.lab-ish.com/', id: '#link-heavy', primaryDomain: 'https://attack.lab-ish.com/' }
];

const CANDIDATE_DOMAINS = [
    'https://victim.lab-ish.com/',
    'https://depth.lab-ish.com/',
    'https://attack.lab-ish.com/'
];

// TARGETS を環境変数や CLI 引数で絞り込み
const targetsToMeasure = (() => {
    const cliArgs = process.argv.slice(2).filter(Boolean);
    const raw = cliArgs.length ? cliArgs.join(',') : (process.env.TARGETS || process.env.TARGET || '');
    if (!raw.trim()) return TARGETS;
    const set = new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const summarizeResources = (resources) => {
    const started = resources.length;
    const success = resources.filter((r) => r.status === 'success').length;
    const canceled = resources.filter((r) => r.status === 'canceled').length;
    const failed = resources.filter((r) => r.status === 'failed').length;
    const pending = resources.filter((r) => r.status === 'pending').length;
    const bytesSuccessTotal = resources
        .filter((r) => r.status === 'success' && typeof r.encodedDataLength === 'number')
        .reduce((sum, r) => sum + r.encodedDataLength, 0);
    return { started, success, canceled, failed, pending, bytesSuccessTotal };
};

(async () => {
    if (!fs.existsSync(USER_DATA_DIR)) {
        fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    }

    fs.writeFileSync(
        OUTPUT_FILE,
        'profile,mode,target,trial,FCP_ms,LCP_ms,num_started,num_success,num_canceled,num_failed,num_pending,bytes_success_total,resources_json\n'
    );

    const browser = await puppeteer.launch({
        headless: 'new',
        ignoreHTTPSErrors: true,
        userDataDir: USER_DATA_DIR,
        env: {
            ...process.env,
            CRASHDUMP_DIRECTORY: USER_DATA_DIR,
            HOME: process.cwd()
        },
        ignoreDefaultArgs: ['--enable-crashpad'],
        args: [
            '--ignore-certificate-errors',
            '--enable-features=SpeculationRules,Prerender2',
            '--no-default-browser-check',
            '--no-first-run',
            '--disable-crash-reporter',
            '--disable-crashpad',
            '--disable-features=Crashpad'
        ]
    });

    console.log('=== tc帯域制御 前提計測 (prefail non-primary) 開始 ===');
    console.log(`profile=${PROFILE_NAME}, mode=${MODE}, trials=${TRIAL_COUNT}, wait=${WAIT_TIME_MS}ms, postNavWait=${POST_NAV_WAIT_MS}ms`);
    console.log(`出力: ${OUTPUT_FILE}\n`);

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
                        0,
                        0,
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

            const currentTrialContext = {
                profile: PROFILE_NAME,
                mode: MODE,
                target: target.name,
                trial: i,
                primaryDomain: target.primaryDomain,
                LCP_ms: null,
                FCP_ms: null,
                resources: [],
                cleanups: []
            };

            const session = await page.target().createCDPSession();
            await session.send('Network.enable');
            const reqIdToResource = new Map();

            const handleRequestWillBeSent = (params) => {
                const url = params.request?.url || '';
                // Discard primary domain; log only non-primary candidates (possible prerender traffic).
                if (!CANDIDATE_DOMAINS.some((d) => url.startsWith(d))) return;
                if (url.startsWith(currentTrialContext.primaryDomain)) return;
                if (reqIdToResource.has(params.requestId)) return;
                const res = {
                    requestId: params.requestId,
                    url,
                    type: params.type || '',
                    status: 'pending',
                    encodedDataLength: null,
                    errorText: null
                };
                currentTrialContext.resources.push(res);
                reqIdToResource.set(params.requestId, res);
            };

            const handleLoadingFailed = (params) => {
                const res = reqIdToResource.get(params.requestId);
                if (!res) return;

                res.status = params.canceled ? 'canceled' : 'failed';
                res.errorText = params.errorText || null;
            };

            const handleLoadingFinished = (params) => {
                const res = reqIdToResource.get(params.requestId);
                if (!res) return;
                if (res.status === 'canceled' || res.status === 'failed') return;
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
                        await page.goto('https://home.lab-ish.com/index.html', { waitUntil: 'domcontentloaded', timeout: TRIAL_TIMEOUT_MS });

                        await sleep(WAIT_TIME_MS);

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

                        if (POST_NAV_WAIT_MS > 0) {
                            await sleep(POST_NAV_WAIT_MS); // give Network events a chance to finish (reduce pending)
                        }

                        return metrics;
                    })(),
                    trialTimeout
                ]);

                clearTimeout(timeoutId);

                currentTrialContext.FCP_ms = Number.isFinite(result?.fcp) ? result.fcp : null;
                currentTrialContext.LCP_ms = Number.isFinite(result?.lcp) ? result.lcp : null;

                const counts = summarizeResources(currentTrialContext.resources);
                const csvLine = [
                    currentTrialContext.profile,
                    currentTrialContext.mode,
                    currentTrialContext.target,
                    currentTrialContext.trial,
                    currentTrialContext.FCP_ms !== null ? currentTrialContext.FCP_ms.toFixed(2) : '',
                    currentTrialContext.LCP_ms !== null ? currentTrialContext.LCP_ms.toFixed(2) : '',
                    counts.started,
                    counts.success,
                    counts.canceled,
                    counts.failed,
                    counts.pending,
                    counts.bytesSuccessTotal,
                    toCsvValue(JSON.stringify(currentTrialContext.resources))
                ].join(',') + '\n';

                fs.appendFileSync(OUTPUT_FILE, csvLine);
                consecutiveFailures = 0;
                process.stdout.write('.');

            } catch (e) {
                clearTimeout(timeoutId);
                consecutiveFailures++;
                console.error(`\n[Error] Trial ${i}: ${e.message}`);

                const counts = summarizeResources(currentTrialContext.resources);
                const csvLine = [
                    currentTrialContext.profile,
                    currentTrialContext.mode,
                    currentTrialContext.target,
                    currentTrialContext.trial,
                    'Timeout',
                    'Timeout',
                    counts.started,
                    counts.success,
                    counts.canceled,
                    counts.failed,
                    counts.pending,
                    counts.bytesSuccessTotal,
                    toCsvValue(JSON.stringify(currentTrialContext.resources))
                ].join(',') + '\n';
                fs.appendFileSync(OUTPUT_FILE, csvLine);
            } finally {
                await Promise.all(currentTrialContext.cleanups.map(async (fn) => fn && fn()));
                await page.close();
            }
        }
        console.log(' 完了');
    }

    console.log('\n=== 全計測終了 ===');
    await browser.close();
})();
