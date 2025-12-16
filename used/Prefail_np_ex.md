Prefail Non-Primary Prerender Measurement Script

Prefail_np.js 詳細説明

1. スクリプトの目的

本スクリプトは，Speculation Rules API（Prerender / Prefetch）により発生する副次的な通信挙動を観測することを目的とする．
特に，

ユーザ操作によって 実際に遷移したページ（primary）

それ以外のページに対して 裏で発生する通信（non-primary）

を明確に分離し，
non-primary サイトへの通信のみを Prerender 起因の可能性がある通信としてログ取得する．

2. 実験設計の前提

帯域制御（tc） は OS 側で事前に設定済みであることを前提とする

Puppeteer 側では帯域制御は行わず，キャッシュ無効化のみを実施

Chrome の Prerender 機能を明示的に有効化する

3. 測定対象ページ構成
home.lab-ish.com
 ├─ Light  → victim.lab-ish.com
 ├─ Medium → depth.lab-ish.com
 └─ Heavy  → attack.lab-ish.com


各試行では：

home にアクセス

指定リンクをクリックして 1サイトにのみ遷移

遷移後に 他サイトへの通信が発生しているかを観測

4. primary / non-primary の定義

Primary site
ユーザ操作（page.click()）によって実際に遷移したドメイン

Non-primary sites
今回の試行では遷移していないが，
Prerender / Prefetch により通信が発生する可能性のあるドメイン

primaryDomain: target.primaryDomain


Network ログでは primaryDomain への通信はすべて除外される．

5. ログ対象ドメイン（候補集合）
const CANDIDATE_DOMAINS = [
  'https://victim.lab-ish.com/',
  'https://depth.lab-ish.com/',
  'https://attack.lab-ish.com/'
];


この集合に含まれ，かつ primaryDomain でない通信のみを
**Prerender 候補通信（non-primary）**として扱う．

6. 試行フロー（1 trial）
6.1 ページ準備

新規ページ作成

キャッシュ無効化

CDP（Chrome DevTools Protocol）Network 有効化

6.2 Network イベント取得
requestWillBeSent

対象ドメインかつ non-primary の場合のみ記録

初期状態は status = pending

loadingFinished

通信成功として status = success

転送量（encodedDataLength）を記録

loadingFailed

canceled = true → status = canceled

それ以外 → status = failed

7. pending の扱い

pending は以下を意味する：

通信開始（requestWillBeSent）は観測されたが，
試行終了までに成功・失敗・キャンセルが確定しなかった通信

対策
POST_NAV_WAIT_MS = 1500


遷移および FCP/LCP 計測後に待機時間を設けることで，
non-primary 通信の確定イベントを待つ設計としている．

8. 性能指標の計測
FCP（First Contentful Paint）
performance.getEntriesByName('first-contentful-paint')

LCP（Largest Contentful Paint）
PerformanceObserver({ type: 'largest-contentful-paint' })

activationStart 補正
FCP/LCP - navigation.activationStart


Prerender による activation を考慮し，
ユーザ視点での体感時間として補正を行う．

9. CSV 出力形式
ヘッダ
profile,mode,target,trial,
FCP_ms,LCP_ms,
num_started,num_success,num_canceled,num_failed,num_pending,
bytes_success_total,resources_json

各指標の意味
列名	内容
num_started	non-primary 通信の開始数
num_success	成功した通信数
num_canceled	明示的にキャンセルされた通信数
num_failed	エラーで失敗した通信数
num_pending	未確定通信数
bytes_success_total	成功通信の総転送量

resources_json には requestId 単位の詳細ログを JSON で保持する．

10. 連続失敗時の安全装置
SKIP_THRESHOLD = 5


5 回連続で試行が失敗した場合：

残り試行を Timeout として埋める

CSV の列数を維持し，解析不能になることを防ぐ

11. このスクリプトで言えること

本スクリプトにより，以下が可能となる：

主遷移以外に発生する Prerender / Prefetch 通信の定量観測

通信環境（tc profile）ごとの副次通信の発生頻度比較

表示性能（FCP/LCP）と副次通信の関係分析

「Prerender が成功扱いされるが実データ転送を伴わない」挙動の検証

12. 研究的位置づけ（まとめ）

本実装は，

「Prerender がユーザ体験を向上させない場合であっても，
背後でどのような通信が発生しているか」

を primary / non-primary の観点で厳密に分離して観測できる点に特徴がある．