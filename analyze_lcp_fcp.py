import glob
import json
import os
from typing import List

import matplotlib.pyplot as plt
import pandas as pd


# ==========================================
# 設定
# ==========================================
INPUT_PATTERNS = ["*.csv"]  # カレントディレクトリの CSV を総読み込み
TARGET_FILTER = os.environ.get("TARGET_FILTER", "Medium")  # 解析対象ターゲット
OUTPUT_SUMMARY = "summary.csv"
OUTPUT_PRERENDER_CANCEL = "prerender_cancel_stats.csv"
OUTPUT_TIMEOUT = "timeout_stats.csv"
OUTPUT_HIST_NORMAL = "M_normal.png"
OUTPUT_HIST_PREFAIL = "M_prefail.png"
OUTPUT_BOXPLOT = "LCP_boxplot.png"


def load_data() -> pd.DataFrame:
    """INPUT_PATTERNS に合致する CSV をまとめて読み込む。"""
    files: List[str] = []
    for pattern in INPUT_PATTERNS:
        files.extend(glob.glob(pattern))

    # 出力ファイルを入力から除外
    outputs = {OUTPUT_SUMMARY, OUTPUT_PRERENDER_CANCEL, OUTPUT_TIMEOUT}
    files = [f for f in files if os.path.basename(f) not in outputs]

    frames = []
    for f in files:
        try:
            frames.append(pd.read_csv(f))
        except Exception as e:  # pragma: no cover - ログ用
            print(f"[warn] skip {f}: {e}")

    if not frames:
        raise SystemExit("No input CSV files found.")

    df = pd.concat(frames, ignore_index=True)
    expected_cols = {
        "profile",
        "mode",
        "target",
        "trial",
        "FCP_ms",
        "LCP_ms",
        "duration_ms",
        "prerenderFlag",
        "timestamp",
        "prerenderRequests",
        "mainRequests",
        "canceledResources",
    }
    missing = expected_cols - set(df.columns)
    if missing:
        raise SystemExit(f"Missing columns: {missing}")
    return df


def preprocess(df: pd.DataFrame) -> pd.DataFrame:
    """ターゲットとタイムアウトを除外して解析対象を抽出。"""
    target_df = df[df["target"] == TARGET_FILTER]
    filtered = target_df[
        (target_df["FCP_ms"] >= 0)
        & (target_df["LCP_ms"] >= 0)
        & (target_df["duration_ms"] >= 0)
    ].copy()
    return filtered


def summarize(df: pd.DataFrame) -> pd.DataFrame:
    """LCP/FCP/duration の統計を (profile, mode) ごとに算出。"""
    grouped = df.groupby(["profile", "mode"])

    lcp_stats = grouped["LCP_ms"].agg(
        LCP_mean="mean",
        LCP_median="median",
        LCP_std="std",
        LCP_min="min",
        LCP_max="max",
    )
    fcp_stats = grouped["FCP_ms"].agg(
        FCP_mean="mean",
        FCP_median="median",
        FCP_std="std",
        FCP_min="min",
        FCP_max="max",
    )
    duration_stats = grouped["duration_ms"].agg(
        duration_mean="mean",
        duration_median="median",
    )

    summary = pd.concat([lcp_stats, fcp_stats, duration_stats], axis=1).reset_index()
    summary.to_csv(OUTPUT_SUMMARY, index=False)
    print(f"Saved {OUTPUT_SUMMARY}")
    return summary


def plot_histograms(df: pd.DataFrame, mode: str, output_path: str):
    """指定 mode の LCP ヒストグラムを profile 別に 2x3 で描画。"""
    subset = df[df["mode"] == mode]
    profiles = sorted(subset["profile"].unique())
    if not profiles:
        print(f"[warn] no data for mode={mode}, skip histogram")
        return

    max_lcp = subset["LCP_ms"].max()
    fig, axes = plt.subplots(2, 3, figsize=(12, 8))
    axes = axes.flatten()

    for idx, ax in enumerate(axes):
        if idx < len(profiles):
            profile = profiles[idx]
            values = subset[subset["profile"] == profile]["LCP_ms"]
            ax.hist(values, bins=20)
            ax.set_title(f"{profile} ({mode})")
            ax.set_xlabel("LCP (ms)")
            ax.set_ylabel("Count")
            ax.set_xlim(0, max_lcp)
        else:
            ax.axis("off")

    fig.suptitle(f"LCP Histogram - {mode}")
    fig.tight_layout(rect=[0, 0.03, 1, 0.95])
    plt.savefig(output_path)
    plt.close(fig)
    print(f"Saved {output_path}")


def plot_boxplot(df: pd.DataFrame):
    """profile ごとに normal/prefail を並べた LCP boxplot を描画。"""
    profiles = sorted(df["profile"].unique())
    modes = ["normal", "prefail"]
    data = []
    labels = []
    positions = []
    pos = 1
    for profile in profiles:
        for m in modes:
            vals = df[(df["profile"] == profile) & (df["mode"] == m)]["LCP_ms"]
            if len(vals) > 0:
                data.append(vals)
                labels.append(f"{profile}\n{m}")
                positions.append(pos)
            pos += 1
        pos += 1  # すこし間隔を空ける

    if not data:
        print("[warn] no data for boxplot")
        return

    fig, ax = plt.subplots(figsize=(12, 6))
    ax.boxplot(data, positions=positions, labels=labels)
    ax.set_ylabel("LCP (ms)")
    ax.set_title("LCP Boxplot by profile/mode")
    plt.savefig(OUTPUT_BOXPLOT, bbox_inches="tight")
    plt.close(fig)
    print(f"Saved {OUTPUT_BOXPLOT}")


def prerender_cancel_stats(df: pd.DataFrame):
    """prerenderFlag と canceledResources の頻度を集計。"""
    def has_cancel(val) -> bool:
        if pd.isna(val):
            return False
        text = str(val).strip()
        if text in ("", "[]"):
            return False
        try:
            parsed = json.loads(text)
            return len(parsed) > 0
        except Exception:
            return True

    df = df.copy()
    df["cancel_non_empty"] = df["canceledResources"].apply(has_cancel)
    grouped = df.groupby(["profile", "mode"])
    stats = grouped.agg(
        total_trials=("trial", "count"),
        prerender_detected=("prerenderFlag", "sum"),
        cancel_non_empty=("cancel_non_empty", "sum"),
    ).reset_index()
    stats["prerender_rate"] = stats["prerender_detected"] / stats["total_trials"]
    stats["cancel_rate"] = stats["cancel_non_empty"] / stats["total_trials"]
    stats.to_csv(OUTPUT_PRERENDER_CANCEL, index=False)
    print(f"Saved {OUTPUT_PRERENDER_CANCEL}")


def timeout_stats(df: pd.DataFrame):
    """タイムアウト (-1) の件数を (profile, mode) ごとに集計。"""
    timeouts = df[(df["FCP_ms"] < 0) | (df["LCP_ms"] < 0)]
    if timeouts.empty:
        print("No timeouts found.")
        pd.DataFrame(columns=["profile", "mode", "timeout_count"]).to_csv(
            OUTPUT_TIMEOUT, index=False
        )
        return
    stats = (
        timeouts.groupby(["profile", "mode"])
        .size()
        .reset_index(name="timeout_count")
    )
    stats.to_csv(OUTPUT_TIMEOUT, index=False)
    print(f"Saved {OUTPUT_TIMEOUT}")


def main():
    raw_df = load_data()
    filtered_df = preprocess(raw_df)

    # 解析
    summarize(filtered_df)
    prerender_cancel_stats(filtered_df)
    timeout_stats(raw_df[raw_df["target"] == TARGET_FILTER])

    # 可視化
    plot_histograms(filtered_df, mode="normal", output_path=OUTPUT_HIST_NORMAL)
    plot_histograms(filtered_df, mode="prefail", output_path=OUTPUT_HIST_PREFAIL)
    plot_boxplot(filtered_df)


if __name__ == "__main__":
    main()
