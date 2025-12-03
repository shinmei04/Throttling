# Premeasure 実験スクリプトの使い方

このドキュメントは `Premeasure.js` を初めて触る人向けの手順書です。実験内容、設定の意味、実行手順、結果の読み方をまとめています。

## 何をするスクリプトか
- Puppeteer でヘッドレス Chrome を立ち上げ、指定したページに対してプリレンダリングの挙動と描画指標を計測します。
- 通信条件（vanilla / 4G / 3G など）ごとに、3 つのターゲット（Light / Medium / Heavy）を繰り返し計測します。
- LCP・FCP・転送量・プリレンダ判定を CSV に追記し、失敗時は `TimeOut` を記録します。
- 全ページでキャッシュを無効化し、作成されるプリレンダ用タブにも同じ帯域制限を適用します。

## 事前準備
- Node.js がインストールされていることを確認してください。
- 依存ライブラリのインストール（初回のみ）:
  ```bash
  npm install
  ```

## ファイル構成のポイント
- `Premeasure.js` … 実験本体。
- 出力 CSV … デフォルトで `raw_prerender1000_data.csv` に追記されます（1 行目にヘッダーを自動生成）。
- ターゲット URL … `TARGETS` で定義（Light / Medium / Heavy）。
- 通信条件 … `NETWORK_CONDITIONS` で定義。`vanilla` は無制限、他は 4G/3G の帯域・遅延を設定。

## 実行手順
1) リポジトリのルートで実行:
   ```bash
   node Premeasure.js
   ```
2) 30 回 × ターゲット × 通信条件を計測します（`TRIAL_COUNT` で回数変更可）。
3) 結果は `raw_prerender1000_data.csv` に順次追記されます。

## 変数の取り方（計測ロジック）
- LCP: ページ内で `PerformanceObserver` を設定し、`largest-contentful-paint` を取得。`activationStart` を引いてクリック後の経過時間（ms）を算出。
- FCP: `performance.getEntriesByName('first-contentful-paint')` の `startTime` から `activationStart` を引いてクリック後の経過時間（ms）。
- 転送量: `performance.getEntriesByType('navigation')` の `transferSize` と、`performance.getEntriesByType('resource')` を合計し、バイトを MB に換算（`/1024/1024`）。
- Prerender 判定: `navigation` エントリの `activationStart` が 0 より大きければ `true`（プリレンダ後にアクティベーションされたとみなす）。
- ネットワーク制限: 各ページで CDP (`Network.emulateNetworkConditions`) を使い、`download`/`upload`/`latency` をプリセット値で指定。値は byte/sec で、`vanilla` は制限なし。
- キャッシュ無効化: `page.setCacheEnabled(false)` を新規ページ作成時に呼び、ブラウザキャッシュの影響を除外。

## 設定を変える場所
- 計測回数: `TRIAL_COUNT`
- 待機時間（Home 滞在時間）: `WAIT_TIME` ミリ秒
- 失敗スキップ閾値: `SKIP_THRESHOLD`（連続失敗がこの回数を超えると残りを TimeOut と記録）
- 出力ファイル名: `OUTPUT_FILE`
- ターゲット URL とクリック要素: `TARGETS`
- 通信条件プリセット: `NETWORK_CONDITIONS`

## 実行の流れ（ざっくり）
1. CSV ヘッダーを書き込み。
2. Puppeteer でブラウザ起動。
3. 通信条件ごとにループ。
4. 各ターゲットごとにループし、以下を 30 回繰り返し:
   - 新規ページ作成 → キャッシュ無効化 → 必要なら帯域制限適用。
   - Home を表示して待機 (`WAIT_TIME`)。
   - 対象リンクをクリックし、遷移完了を待つ。
   - LCP/FCP/転送量/プリレンダ判定を取得し、CSV に 1 行追記。
   - 失敗時は `TimeOut` を追記し、5 回連続失敗で残りをスキップ。
5. すべての条件・ターゲット終了後にブラウザを閉じて完了ログを出力。

## 失敗時の挙動
- `networkidle0` やナビゲーションがタイムアウトすると、その試行は `TimeOut` として CSV に書き込みます。
- 連続失敗が `SKIP_THRESHOLD` を超えると、残りの試行も `TimeOut` をまとめて書き込み、次のターゲットへ進みます。

## 結果の見方（CSV）
カラム順: `Condition, Page, Trial_No, LCP_ms, FCP_ms, Transfer_MB, Prerendered`
- `Condition` … 通信条件プリセット名。
- `Page` … Light / Medium / Heavy。
- `Trial_No` … 試行番号。
- `LCP_ms` / `FCP_ms` … クリック後の経過時間（ms）。
- `Transfer_MB` … 転送量合計（MB）。
- `Prerendered` … アクティベーション開始が 0 以上なら `true` でプリレンダ成功判定。

## よくある変更例
- 回数を減らして試し撮りしたい: `TRIAL_COUNT` を 3 や 5 に変更。
- 通信条件を追加したい: `NETWORK_CONDITIONS` に新しいキーを追加（download/upload は byte/sec）。
- 出力ファイルを分けたい: `OUTPUT_FILE` を任意の CSV 名に変更して保存先を分離。

## トラブルシュート
- SSL 証明書エラー: `ignoreHTTPSErrors: true` で回避していますが、ネットワーク制限で到達できないとタイムアウトします。
- 帯域制限が効いていない: すべての新規ページ（プリレンダタブ含む）に CDP で `Network.emulateNetworkConditions` を適用するよう実装済み。Node を再起動して再実行してください。
- キャッシュが効いてしまう: `setCacheEnabled(false)` をページ作成時に呼んでいます。ブラウザを再起動してから実行してください。

## 実行前チェックリスト
- 依存をインストール済みか (`npm install` 済み)。
- `OUTPUT_FILE` の保存先に書き込み権限があるか。
- 計測中はブラウザを閉じないこと（自動で終了します）。
