# Product Overview

Nostr Relay - 分散型ソーシャルネットワークNostrのためのパーソナルリレーサーバー実装。

WebSocketプロトコルを通じてNostrイベントの受信・保存・配信を行い、Nostrネットワークの一端を担う。

## Core Capabilities

- **イベント中継**: NIP-01準拠のNostrプロトコルによるイベント送受信
- **WebSocket接続管理**: クライアントとの永続的な双方向通信
- **サブスクリプション処理**: フィルターに基づくイベントの購読・配信
- **サーバーレス運用**: AWS Lambda上で動作するスケーラブルな構成

## Target Use Cases

- 個人用Nostrリレーサーバーの運用
- 自身のイベントを確実に保存・配信するプライマリリレー
- Nostrプロトコル実装の学習・実験

## Value Proposition

- **完全なコントロール**: 自身のデータを自分のインフラで管理
- **サーバーレスアーキテクチャ**: 従量課金・低運用コスト・自動スケーリング
- **プロトコル準拠**: NIP仕様に基づいた標準的なリレー実装
- **モダンな技術スタック**: Rust + AWS Lambda による高性能・安全な実装

## Protocol Reference

Nostrプロトコル仕様は `nips/` サブモジュール（公式リポジトリ）を参照。
Relay実装に関連するNIPの要約は `RELAY_NIPS.md` に記載。

---
_Focus on patterns and purpose, not exhaustive feature lists_
