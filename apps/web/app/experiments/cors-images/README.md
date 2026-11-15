# CORS画像実験の配信設定

このrouteは通常の画像proxy設定と独立している。Vercelでは `CANVAS_CORS_EXPERIMENT_ENABLED=1` を **Preview target / `experiment/canvas-cors-images` branchのみ** に設定する。Production、全環境、別ブランチには設定しない。環境変数変更後は新しいPreview deploymentが必要。

Vercel projectのSystem Environment Variablesへのアクセスが無効な場合、`VERCEL_ENV` と `VERCEL_TARGET_ENV` は実行環境に渡らない。この設定は変更せず、専用の明示的なopt-inを使う。変数はnext.configのenvやNEXT_PUBLIC変数に埋め込まず、`force-dynamic` routeのserver実行時に読む。ローカルの`next dev`は有効、production buildの起動は専用変数未設定なら404。system変数が存在して本番・未知の環境を指す場合は専用変数が1でも404。

配信確認はREADYやSSOへの302だけで完了としない。既存の許可されたPreviewアクセスで保護の内側にある実験案内とCORS取得方式の表示を確認する。画像用の本人署名、保護設定変更、share link作成は不要。
