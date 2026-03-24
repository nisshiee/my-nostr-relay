#!/bin/bash
# kind:31990 (NIP-89 Application Handler) 発行スクリプト
# Nostr Live Canvas のハンドラーイベントを全writeリレーに発行する
#
# 使い方: bash publish-handler.sh

set -euo pipefail

HOME_RELAY="wss://relay.nostr.nisshiee.org"

# --- アプリ情報 ---
APP_NAME="Nostr Live Canvas"
APP_ABOUT="A live, canvas-style Nostr client"
APP_PICTURE="https://nostr.nisshiee.org/icon.png"
D_TAG="nostr-live-canvas"
# 対応 event kinds
KINDS=("1" "7" "6")

# --- nsec入力（エコーバックなし）---
printf "nsec (hex or nsec): "
stty -echo
read -r NSEC
stty echo
echo

# 不可視文字・制御文字を除去
NSEC=$(printf '%s' "$NSEC" | tr -cd '[:alnum:]')

# nsec形式ならhexに変換
if [[ "$NSEC" == nsec1* ]]; then
  SEC_HEX=$(nak decode "$NSEC")
else
  SEC_HEX="$NSEC"
fi

# hexからpubkeyを導出
PUBKEY=$(nak key public "$SEC_HEX")
echo "📋 pubkey: $PUBKEY"

# --- kind:10002 からwriteリレー一覧を取得 ---
echo "📡 kind:10002 からリレー一覧を取得中..."
RELAYS=$(nak req -k 10002 -a "$PUBKEY" --limit 1 --auth --sec "$SEC_HEX" "$HOME_RELAY" 2>/dev/null \
  | jq -r '.tags[] | select(.[0] == "r") | select((.[2] // "write") != "read") | .[1]')

if [ -z "$RELAYS" ]; then
  echo "⚠️ kind:10002 が見つかりません。ホームリレーのみ使用します"
  RELAYS="$HOME_RELAY"
fi

echo "送信先リレー:"
echo "$RELAYS" | sed 's/^/  /'
echo ""

# --- content JSON ---
CONTENT=$(jq -cn \
  --arg name "$APP_NAME" \
  --arg about "$APP_ABOUT" \
  --arg picture "$APP_PICTURE" \
  '{name: $name, about: $about, picture: $picture}')

echo "📝 イベント内容:"
echo "  kind: 31990"
echo "  d: $D_TAG"
echo "  content: $CONTENT"
echo "  k tags: ${KINDS[*]}"
echo ""

# --- 確認 ---
printf "発行しますか？ (y/N): "
read -r CONFIRM
if [ "$CONFIRM" != "y" ]; then
  echo "キャンセルしました"
  exit 0
fi

# --- タグ引数を組み立て ---
TAG_ARGS=(-d "$D_TAG")
for k in "${KINDS[@]}"; do
  TAG_ARGS+=(-t "k=$k")
done

# --- 全writeリレーに発行 ---
RELAY_ARGS=()
while IFS= read -r relay; do
  RELAY_ARGS+=("$relay")
done <<< "$RELAYS"

echo "📡 kind:31990 発行中..."
nak event \
  -k 31990 \
  -c "$CONTENT" \
  "${TAG_ARGS[@]}" \
  --sec "$SEC_HEX" \
  --auth \
  "${RELAY_ARGS[@]}"

echo ""
echo "✅ 完了！"
echo ""
echo "clientタグ（イベント投稿時に付与する形式）:"
echo "  [\"client\", \"$APP_NAME\", \"31990:$PUBKEY:$D_TAG\", \"$HOME_RELAY\"]"
