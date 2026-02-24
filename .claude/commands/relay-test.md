---
description: Nostrリレーの動作確認テストを実行
allowed-tools: Bash, Read
arg-description: "リレーURL (例: ws://127.0.0.1:3000, wss://relay.nostr.nisshiee.org)"
---

# Nostrリレー動作確認

nakコマンドとwebsocatを使ってNostrリレーの動作確認を行ってください。

## 引数

```
$ARGUMENTS
```

- 引数が指定された場合: そのURLをリレーURLとして使用
- 引数が未指定の場合: `wss://relay.nostr.nisshiee.org` をデフォルトとして使用

**注意**: ローカルテスト時は `ws://127.0.0.1:3000` のように `ws://` スキームを使用してください。

## テスト手順

以下の順序でテストを実行してください。HTTPエンドポイントは、WebSocket URLから適切に変換してください（`wss://` → `https://`、`ws://` → `http://`）。

---

### 1. NIP-11 リレー情報取得テスト

```bash
curl -s -H "Accept: application/nostr+json" <HTTP_URL>/ | jq .
```

- JSONでリレー情報が返されれば成功
- `name`, `description`, `pubkey`, `supported_nips` 等のフィールドを確認
- 未実装の場合はその旨を報告

---

### 2. WebSocket接続テスト

```bash
nak req -k 1 -l 1 <RELAY_URL>
```

- `connecting to ... ok.` が表示されれば接続成功

---

### 3. イベント投稿テスト

```bash
nak event --sec "$(nak key generate)" -k 1 -c "relay test $(date +%Y%m%d-%H%M%S)" <RELAY_URL>
```

- `publishing to ... success.` が表示されれば投稿成功

---

### 4. イベント取得テスト

```bash
nak req -k 1 -l 5 <RELAY_URL>
```

- 投稿したイベントがJSON形式で表示されれば取得成功

---

### 5. 複数イベント投稿・公開鍵フィルタテスト

同一秘密鍵で複数イベントを投稿し、公開鍵フィルタでの取得を確認:

```bash
TEST_KEY=$(nak key generate)
TEST_PUBKEY=$(nak key public $TEST_KEY)
for i in 1 2 3; do
  nak event --sec "$TEST_KEY" -k 1 -c "test message $i" <RELAY_URL>
done
```

公開鍵フィルタで取得:
```bash
nak req -a $TEST_PUBKEY <RELAY_URL>
```

- 投稿した3件のイベントがすべて取得できれば成功

---

### 6. イベントIDフィルタテスト

前のテストで投稿したイベントのIDを使用:
```bash
nak req -i <EVENT_ID> <RELAY_URL>
```

- 指定したIDのイベントのみが取得できれば成功

---

### 7. limitフィルタテスト

```bash
nak req -k 1 -l 2 <RELAY_URL>
```

- 指定した件数（2件）のみが返されれば成功

---

### 8. 生プロトコルテスト（websocat使用）

REQメッセージとEOSE確認:
```bash
timeout 3 bash -c 'echo '\''["REQ","test-sub",{"kinds":[1],"limit":3}]'\'' | websocat <RELAY_URL>' || true
```

- `["EVENT","test-sub",{...}]` 形式でイベントが返される
- 最後に `["EOSE","test-sub"]` が返されれば成功

---

### 9. リアルタイムイベント転送テスト（Pub/Subパターン）

サブスクリプションを開いた状態で、別クライアントからのイベント投稿がリアルタイムで転送されることを確認:

```bash
# 一時ファイルのクリーンアップ
rm -f /tmp/nostr_out

# バックグラウンドでサブスクリプションを開く（limit:0で過去イベントは取得せず、新規イベントのみ待機）
(echo '["REQ","realtime-sub",{"kinds":[1],"limit":0}]'; sleep 8) | websocat <RELAY_URL> > /tmp/nostr_out 2>&1 &
WS_PID=$!
sleep 2

# 新しいイベントを投稿（別クライアントとして）
TEST_KEY=$(nak key generate)
nak event --sec "$TEST_KEY" -k 1 -c "realtime test $(date +%s)" <RELAY_URL>

# 転送されるまで待機
sleep 3

# 結果を確認
echo "=== Received messages ==="
cat /tmp/nostr_out

# クリーンアップ
kill $WS_PID 2>/dev/null
rm -f /tmp/nostr_out
```

- `["EOSE","realtime-sub"]` の後に `["EVENT","realtime-sub",{...}]` が受信されれば成功
- 投稿したイベントの `content` に "realtime test" が含まれていることを確認

---

### 10. CLOSEコマンドテスト

```bash
timeout 3 bash -c '{ echo '\''["REQ","sub1",{"kinds":[1],"limit":1}]'\''; sleep 0.5; echo '\''["CLOSE","sub1"]'\''; sleep 0.5; } | websocat <RELAY_URL>' || true
```

- `["CLOSED","sub1",""]` または接続が正常に終了すれば成功

---

### 11. エラーハンドリングテスト

不正なイベントを送信:
```bash
timeout 3 bash -c 'echo '\''["EVENT",{"id":"invalid","pubkey":"invalid","created_at":0,"kind":1,"tags":[],"content":"test","sig":"invalid"}]'\'' | websocat <RELAY_URL>' || true
```

- `["OK","...",false,"..."]` または `["NOTICE","..."]` でエラーが返されれば成功

---

## 期待される結果

| テスト | 成功条件 |
|--------|----------|
| NIP-11 | JSONでリレー情報が返される（未実装の場合は報告） |
| WebSocket接続 | `ok.` が表示される |
| イベント投稿 | `success.` が表示される |
| イベント取得 | JSONイベントが返される |
| 公開鍵フィルタ | 指定公開鍵のイベントのみ返される |
| イベントIDフィルタ | 指定IDのイベントのみ返される |
| limitフィルタ | 指定件数のみ返される |
| EOSE | `["EOSE","subscription_id"]` が返される |
| リアルタイム転送 | EOSE後に新規イベントが `["EVENT",...]` で転送される |
| CLOSE | `["CLOSED","subscription_id",""]` が返される（オプショナル） |
| エラーハンドリング | 不正イベントにエラー応答が返される |

---

## テスト結果報告

テスト完了後、以下の形式で結果をまとめてください:

```
## テスト結果まとめ

| テスト | 結果 | 詳細 |
|--------|------|------|
| NIP-11 | ✅/❌ | ... |
| WebSocket接続 | ✅/❌ | ... |
| ... | ... | ... |

### 所見
- 動作している機能
- 未実装/問題のある機能
```

---

## トラブルシューティング

本番リレー（relay.nostr.nisshiee.org）でエラーが発生した場合は、以下のLambdaログを確認してください：

```bash
aws-vault exec nostr-relay -- aws logs tail /aws/lambda/nostr_relay_nip11_info --since 5m
aws-vault exec nostr-relay -- aws logs tail /aws/lambda/nostr_relay_connect --since 5m
aws-vault exec nostr-relay -- aws logs tail /aws/lambda/nostr_relay_default --since 5m
aws-vault exec nostr-relay -- aws logs tail /aws/lambda/nostr_relay_disconnect --since 5m
```
