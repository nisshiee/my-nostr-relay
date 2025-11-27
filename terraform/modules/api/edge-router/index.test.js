/**
 * Lambda@Edge edge-router ユニットテスト
 *
 * 以下のケースを検証:
 * - OPTIONSリクエストでCORS応答が直接返却される
 * - Accept: application/nostr+json でNIP-11オリジンに切り替え
 * - WebSocket Upgradeヘッダーでデフォルトオリジン維持
 * - 通常のHTTPリクエストでデフォルトオリジン維持
 */

const { handler } = require('./index');

/**
 * CloudFront Viewer Requestイベントのモックを生成
 * @param {string} method - HTTPメソッド
 * @param {Object} headers - リクエストヘッダー
 * @returns {Object} CloudFrontイベントオブジェクト
 */
function createEvent(method, headers = {}) {
  // ヘッダーをCloudFront形式に変換
  const cfHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    cfHeaders[key.toLowerCase()] = [{ key: key, value: value }];
  }

  return {
    Records: [
      {
        cf: {
          request: {
            method: method,
            uri: '/',
            headers: cfHeaders,
            origin: {
              custom: {
                domainName: 'default-origin.example.com',
                port: 443,
                protocol: 'https',
                path: '',
                sslProtocols: ['TLSv1.2'],
                readTimeout: 30,
                keepaliveTimeout: 5
              }
            }
          }
        }
      }
    ]
  };
}

describe('edge-router Lambda@Edge', () => {
  // -----------------------------------------------------------------------
  // Task 5.2: CORSプリフライトリクエスト処理
  // -----------------------------------------------------------------------
  describe('OPTIONS (CORSプリフライト) リクエスト', () => {
    test('OPTIONSリクエストでCORSヘッダー付きレスポンスを直接返却', async () => {
      const event = createEvent('OPTIONS');
      const result = await handler(event);

      // レスポンスオブジェクトが返される（リクエストオブジェクトではない）
      expect(result).toHaveProperty('status', '200');
      expect(result).toHaveProperty('statusDescription', 'OK');
    });

    test('Access-Control-Allow-Origin: * ヘッダーが含まれる', async () => {
      const event = createEvent('OPTIONS');
      const result = await handler(event);

      expect(result.headers).toHaveProperty('access-control-allow-origin');
      expect(result.headers['access-control-allow-origin'][0].value).toBe('*');
    });

    test('Access-Control-Allow-Methods: GET, OPTIONS ヘッダーが含まれる', async () => {
      const event = createEvent('OPTIONS');
      const result = await handler(event);

      expect(result.headers).toHaveProperty('access-control-allow-methods');
      expect(result.headers['access-control-allow-methods'][0].value).toBe('GET, OPTIONS');
    });

    test('Access-Control-Allow-Headers: Accept ヘッダーが含まれる', async () => {
      const event = createEvent('OPTIONS');
      const result = await handler(event);

      expect(result.headers).toHaveProperty('access-control-allow-headers');
      expect(result.headers['access-control-allow-headers'][0].value).toBe('Accept');
    });

    test('Access-Control-Max-Age: 86400 ヘッダーが含まれる', async () => {
      const event = createEvent('OPTIONS');
      const result = await handler(event);

      expect(result.headers).toHaveProperty('access-control-max-age');
      expect(result.headers['access-control-max-age'][0].value).toBe('86400');
    });

    test('レスポンスボディが空文字列', async () => {
      const event = createEvent('OPTIONS');
      const result = await handler(event);

      expect(result).toHaveProperty('body', '');
    });
  });

  // -----------------------------------------------------------------------
  // Task 5.1: NIP-11ルーティング
  // -----------------------------------------------------------------------
  describe('Accept: application/nostr+json ルーティング', () => {
    test('NIP-11オリジンへの切り替えが行われる', async () => {
      const event = createEvent('GET', {
        'Accept': 'application/nostr+json'
      });
      const result = await handler(event);

      // リクエストオブジェクトが返される（オリジン転送）
      expect(result).toHaveProperty('method', 'GET');
      expect(result).toHaveProperty('origin');
      // NIP-11オリジンに切り替わっていることを確認
      // （実際のドメイン名はテンプレート変数で埋め込まれる）
      expect(result.origin.custom.domainName).not.toBe('default-origin.example.com');
    });

    test('複数のAcceptタイプにapplication/nostr+jsonが含まれる場合もルーティング', async () => {
      const event = createEvent('GET', {
        'Accept': 'text/html, application/nostr+json, application/json'
      });
      const result = await handler(event);

      expect(result).toHaveProperty('origin');
      expect(result.origin.custom.domainName).not.toBe('default-origin.example.com');
    });

    test('Hostヘッダーが新しいオリジンに更新される', async () => {
      const event = createEvent('GET', {
        'Accept': 'application/nostr+json'
      });
      const result = await handler(event);

      expect(result.headers).toHaveProperty('host');
      expect(result.headers['host'][0].value).not.toBe('default-origin.example.com');
    });
  });

  // -----------------------------------------------------------------------
  // Task 5.3 (一部): WebSocketリクエストのデフォルトオリジン維持
  // -----------------------------------------------------------------------
  describe('WebSocketリクエスト', () => {
    test('Upgrade: websocket ヘッダーでデフォルトオリジン維持', async () => {
      const event = createEvent('GET', {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13'
      });
      const result = await handler(event);

      // オリジンが変更されていないことを確認
      expect(result.origin.custom.domainName).toBe('default-origin.example.com');
    });

    test('WebSocketとAccept両方ある場合、WebSocketを優先', async () => {
      // WebSocketクライアントがAcceptヘッダーを送信する可能性がある
      const event = createEvent('GET', {
        'Accept': 'application/nostr+json',
        'Upgrade': 'websocket',
        'Connection': 'Upgrade'
      });
      const result = await handler(event);

      // WebSocketリクエストとして扱われ、デフォルトオリジンが維持される
      expect(result.origin.custom.domainName).toBe('default-origin.example.com');
    });
  });

  // -----------------------------------------------------------------------
  // 通常のHTTPリクエスト（デフォルトルーティング）
  // -----------------------------------------------------------------------
  describe('通常のHTTPリクエスト', () => {
    test('Acceptヘッダーなしでデフォルトオリジン維持', async () => {
      const event = createEvent('GET');
      const result = await handler(event);

      expect(result.origin.custom.domainName).toBe('default-origin.example.com');
    });

    test('Accept: text/html でデフォルトオリジン維持', async () => {
      const event = createEvent('GET', {
        'Accept': 'text/html'
      });
      const result = await handler(event);

      expect(result.origin.custom.domainName).toBe('default-origin.example.com');
    });

    test('Accept: application/json でデフォルトオリジン維持', async () => {
      const event = createEvent('GET', {
        'Accept': 'application/json'
      });
      const result = await handler(event);

      expect(result.origin.custom.domainName).toBe('default-origin.example.com');
    });

    test('POSTリクエストでデフォルトオリジン維持', async () => {
      const event = createEvent('POST');
      const result = await handler(event);

      expect(result.origin.custom.domainName).toBe('default-origin.example.com');
    });
  });
});
