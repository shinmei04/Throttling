"""
Quick analysis helpers for prerender experiment CSVs.

Usage examples:
    python analyze_prerender.py raw_prerender1000_data.csv --out plots
    python analyze_prerender.py raw_prerender_cpu_multi.csv --out plots_cpu

This script expects pandas/seaborn/matplotlib to be installed in the environment
where you run it (e.g., your Jupyter setup).
"""

import argparse
import os
from pathlib import Path
from typing import Optional

import pandas as pd
import seaborn as sns
import matplotlib.pyplot as plt


def load_data(path: Path) -> pd.DataFrame:
    """Load CSV and coerce numeric columns, treating 'TimeOut' as NaN."""
    df = pd.read_csv(path)

    # Standard columns
    numeric_cols = [c for c in ['LCP_ms', 'FCP_ms', 'Transfer_MB'] if c in df.columns]
    for col in numeric_cols:
        df[col] = pd.to_numeric(df[col], errors='coerce')

    # Normalize Prerendered to bool
    if 'Prerendered' in df.columns:
        df['Prerendered'] = df['Prerendered'].astype(str).str.lower().isin(['true', '1'])

    return df


def summarize(df: pd.DataFrame) -> pd.DataFrame:
    """Compute basic aggregates per condition/page (and CpuRate if present)."""
    group_cols = ['Condition', 'Page']
    if 'CpuRate' in df.columns:
        group_cols.insert(1, 'CpuRate')  # Condition, CpuRate, Page

    aggregations = {
        'LCP_ms': ['mean', 'median', 'std', 'count'],
        'FCP_ms': ['mean', 'median', 'std'],
        'Transfer_MB': ['mean', 'median'],
        'Prerendered': 'mean',  # success rate
    }

    existing_aggs = {k: v for k, v in aggregations.items() if k in df.columns}
    summary = df.groupby(group_cols).agg(existing_aggs)
    summary.columns = ['_'.join(filter(None, map(str, col))).strip('_') for col in summary.columns]

    # Timeout rate = rows where metrics missing
    if 'LCP_ms' in df.columns:
        summary['timeout_rate'] = 1 - (summary['LCP_ms_count'] / TRIALS_PER_GROUP(df, group_cols))

    return summary.reset_index()


def TRIALS_PER_GROUP(df: pd.DataFrame, group_cols: list) -> float:
    """Infer total trials per group from the most common Trial_No count."""
    if 'Trial_No' not in df.columns:
        return float('nan')
    counts = df.groupby(group_cols)['Trial_No'].nunique()
    return counts.mode().iloc[0] if not counts.empty else float('nan')


def plot_metric(df: pd.DataFrame, metric: str, out_dir: Optional[Path], title_suffix: str = "") -> None:
    """Boxplot of a metric by Condition (and CpuRate if present)."""
    if metric not in df.columns:
        return

    hue = 'CpuRate' if 'CpuRate' in df.columns else 'Page'
    plt.figure(figsize=(10, 6))
    sns.boxplot(data=df, x='Condition', y=metric, hue=hue)
    plt.title(f"{metric} by Condition {title_suffix}")
    plt.xticks(rotation=30)
    plt.tight_layout()

    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
        fname = out_dir / f"box_{metric}.png"
        plt.savefig(fname, dpi=200)
    else:
        plt.show()
    plt.close()


def plot_prerender_rate(df: pd.DataFrame, out_dir: Optional[Path], title_suffix: str = "") -> None:
    if 'Prerendered' not in df.columns:
        return
    group_cols = ['Condition'] + (['CpuRate'] if 'CpuRate' in df.columns else []) + ['Page']
    rate = df.groupby(group_cols)['Prerendered'].mean().reset_index()

    plt.figure(figsize=(10, 6))
    sns.barplot(data=rate, x='Condition', y='Prerendered', hue='Page' if 'Page' in rate.columns else None)
    plt.ylim(0, 1)
    plt.title(f"Prerender success rate {title_suffix}")
    plt.xticks(rotation=30)
    plt.tight_layout()

    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
        fname = out_dir / "bar_prerender_rate.png"
        plt.savefig(fname, dpi=200)
    else:
        plt.show()
    plt.close()


def main():
    parser = argparse.ArgumentParser(description="Summarize and visualize prerender experiment CSVs")
    parser.add_argument('csv', type=Path, help='Input CSV path')
    parser.add_argument('--out', type=Path, default=None, help='Output directory for plots (optional)')
    args = parser.parse_args()

    df = load_data(args.csv)
    summary = summarize(df)
    print("\n=== Summary (per condition) ===")
    print(summary.to_string(index=False))

    title_suffix = f"({args.csv.name})"
    plot_metric(df, 'LCP_ms', args.out, title_suffix)
    plot_metric(df, 'FCP_ms', args.out, title_suffix)
    plot_metric(df, 'Transfer_MB', args.out, title_suffix)
    plot_prerender_rate(df, args.out, title_suffix)


if __name__ == '__main__':
    main()
