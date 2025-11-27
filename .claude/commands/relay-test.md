# Nostrリレー動作確認

nakコマンドを使ってNostrリレー（wss://relay.nostr.nisshiee.org）の動作確認を行ってください。

## テスト手順

以下の順序でテストを実行してください：

### 1. 接続テスト
```bash
nak req -k 1 -l 1 wss://relay.nostr.nisshiee.org
```
- "connecting to ... ok." が表示されれば接続成功

### 2. イベント投稿テスト
```bash
nak event --sec "$(nak key generate)" -k 1 -c "relay test $(date +%Y%m%d-%H%M%S)" wss://relay.nostr.nisshiee.org
```
- "publishing to ... success." が表示されれば投稿成功

### 3. イベント取得テスト
```bash
nak req -k 1 -l 5 wss://relay.nostr.nisshiee.org
```
- 投稿したイベントがJSON形式で表示されれば取得成功

## 期待される結果

| テスト | 成功条件 |
|--------|----------|
| 接続 | "ok." が表示される |
| 投稿 | "success." が表示される |
| 取得 | JSONイベントが返される |

## トラブルシューティング

エラーが発生した場合は、以下のLambdaログを確認してください：

```bash
aws-vault exec nostr-relay -- aws logs tail /aws/lambda/nostr_relay_connect --since 5m
aws-vault exec nostr-relay -- aws logs tail /aws/lambda/nostr_relay_default --since 5m
aws-vault exec nostr-relay -- aws logs tail /aws/lambda/nostr_relay_disconnect --since 5m
```

テストを実行し、結果を報告してください。
