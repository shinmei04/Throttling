#!/usr/bin/env bash
# クライアント側インターフェース。ip addr で見えた eth0 を使う
IF="${IF:-eth0}"

tc_clear() {
  # eth0 に付いている遅延/帯域制限の設定をすべて削除して初期状態に戻す
  tc qdisc del dev "$IF" root 2>/dev/null || true
}

tc_fast4g() {
  tc_clear
  # Fast 4G:
  # download ≒ 100Mbps, latency ≒ 5ms を再現
  tc qdisc add dev "$IF" root handle 1: netem delay 20ms rate 100mbit
}

tc_regular4g() {
  tc_clear
  # Regular 4G:
  # download ≒ 30Mbps, latency ≒ 20ms を再現
  tc qdisc add dev "$IF" root handle 1: netem delay 20ms rate 30mbit
}

tc_fast3g() {
  tc_clear
  # Fast 3G:
  # download ≒ 1.5Mbps, latency ≒ 20ms を再現
  tc qdisc add dev "$IF" root handle 1: netem delay 20ms rate 1.5mbit
}

tc_slow3g() {
  tc_clear
  # Slow 3G:
  # download ≒ 0.4Mbps(400kbps), latency ≒ 20ms を再現
  tc qdisc add dev "$IF" root handle 1: netem delay 20ms rate 400kbit
}

tc_show() {
  # 現在 eth0 にどんな遅延/帯域制限が掛かっているか確認する
  tc qdisc show dev "$IF"
}

case "$1" in
  clear)     tc_clear ;;
  fast4g)    tc_fast4g ;;
  regular4g) tc_regular4g ;;
  fast3g)    tc_fast3g ;;
  slow3g)    tc_slow3g ;;
  show)      tc_show ;;
  "" ) ;;  # 引数なしのときは何もしない
  * )
    echo "usage: $0 {clear|fast4g|regular4g|fast3g|slow3g|show}" >&2
    exit 1
    ;;
esac
