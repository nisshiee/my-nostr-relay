/**
 * Lambda@Edge edge-router
 *
 * CloudFront Viewer Requestイベントを処理し、
 * リクエストの種類に応じて適切なオリジンへルーティングする。
 *
 * - OPTIONSリクエスト: CORSプリフライト応答を直接返却
 * - Accept: application/nostr+json: NIP-11オリジンへルーティング
 * - その他: デフォルトオリジン（WebSocket API Gateway）へ転送
 *
 * 注意: Lambda@Edgeでは環境変数が使用できないため、
 * NIP-11オリジンのドメイン名はTerraform templatefile関数で埋め込む
 */

// NIP-11 Lambda Function URLのドメイン名
// Terraformのtemplatefileで置換される（例: xxxx.lambda-url.ap-northeast-1.on.aws）
const NIP11_ORIGIN_DOMAIN = '${nip11_function_url_domain}';

/**
 * CORSプリフライトレスポンスを生成
 * OPTIONSリクエストに対して直接レスポンスを返却し、オリジンへの転送を回避
 * @returns {Object} CloudFrontレスポンスオブジェクト
 */
function buildCorsPreflightResponse() {
  return {
    status: '200',
    statusDescription: 'OK',
    headers: {
      'access-control-allow-origin': [{ key: 'Access-Control-Allow-Origin', value: '*' }],
      'access-control-allow-methods': [{ key: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' }],
      'access-control-allow-headers': [{ key: 'Access-Control-Allow-Headers', value: 'Accept' }],
      'access-control-max-age': [{ key: 'Access-Control-Max-Age', value: '86400' }],
    },
    body: '',
  };
}

/**
 * リクエストがWebSocketアップグレードかどうかを判定
 * @param {Object} headers - CloudFront形式のヘッダーオブジェクト
 * @returns {boolean} WebSocketアップグレードリクエストの場合true
 */
function isWebSocketUpgrade(headers) {
  const upgradeHeader = headers['upgrade'];
  if (!upgradeHeader || upgradeHeader.length === 0) {
    return false;
  }
  // Upgrade: websocket を検出
  return upgradeHeader.some(h => h.value.toLowerCase() === 'websocket');
}

/**
 * リクエストがNIP-11（application/nostr+json）を要求しているかどうかを判定
 * @param {Object} headers - CloudFront形式のヘッダーオブジェクト
 * @returns {boolean} NIP-11リクエストの場合true
 */
function isNip11Request(headers) {
  const acceptHeader = headers['accept'];
  if (!acceptHeader || acceptHeader.length === 0) {
    return false;
  }
  // Accept: application/nostr+json を検出（複数のタイプが列挙されていても対応）
  return acceptHeader.some(h => h.value.includes('application/nostr+json'));
}

/**
 * リクエストをNIP-11オリジンへルーティング
 * @param {Object} request - CloudFrontリクエストオブジェクト
 * @returns {Object} NIP-11オリジンに転送するよう変更されたリクエスト
 */
function routeToNip11Origin(request) {
  // カスタムオリジンをNIP-11 Lambda Function URLに変更
  request.origin = {
    custom: {
      domainName: NIP11_ORIGIN_DOMAIN,
      port: 443,
      protocol: 'https',
      path: '',
      sslProtocols: ['TLSv1.2'],
      readTimeout: 30,
      keepaliveTimeout: 5,
    },
  };
  // HostヘッダーをNIP-11オリジンに合わせて更新
  request.headers['host'] = [{ key: 'Host', value: NIP11_ORIGIN_DOMAIN }];
  return request;
}

/**
 * Lambda@Edge ハンドラー
 * @param {Object} event - CloudFront Viewer Requestイベント
 * @returns {Object} レスポンスまたは変更されたリクエスト
 */
exports.handler = async (event) => {
  const request = event.Records[0].cf.request;
  const headers = request.headers;
  const method = request.method;

  // 1. OPTIONSプリフライトリクエストは直接レスポンスを返却（オリジン転送なし）
  if (method === 'OPTIONS') {
    return buildCorsPreflightResponse();
  }

  // 2. WebSocketアップグレードリクエストはデフォルトオリジンへ転送
  //    （NIP-11のAcceptヘッダーがあっても、WebSocketを優先）
  if (isWebSocketUpgrade(headers)) {
    return request;
  }

  // 3. Accept: application/nostr+json リクエストはNIP-11オリジンへルーティング
  if (isNip11Request(headers)) {
    return routeToNip11Origin(request);
  }

  // 4. その他のリクエストはデフォルトオリジン（WebSocket API Gateway）へ転送
  return request;
};
