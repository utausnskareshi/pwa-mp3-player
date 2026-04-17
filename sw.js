/**
 * sw.js - Service Worker（PWA オフライン対応）
 *
 * 【概要】
 * このService Workerは PWA MP3 Player のオフライン動作を実現する。
 * アプリのシェル（HTML/CSS/JS）を初回インストール時にキャッシュし、
 * 以降はネットワークなしでも完全に動作させる。
 *
 * 【キャッシュ戦略: Cache First】
 * リクエストを受けると、まずキャッシュを確認する。
 * キャッシュにあれば即座に返す（高速 & オフライン対応）。
 * キャッシュになければネットワークから取得してキャッシュに保存する。
 *
 *   ブラウザ → [fetch] → Service Worker
 *                               │
 *                     キャッシュに存在?
 *                        YES │     │ NO
 *                            ↓     ↓
 *                         返す  ネットワークから取得
 *                                  │
 *                           キャッシュに保存
 *                                  │
 *                               返す
 *
 * 【MP3ファイルのキャッシュについて】
 * MP3ファイル本体はキャッシュしない。代わりにIndexedDBに保存する。
 * Service Workerのキャッシュは容量制限があり（通常50MB〜数GB）、
 * 大きなMP3ファイルは IndexedDB の方が適切なため。
 *
 * 【バージョン更新時の動作】
 * CACHE_VERSION を変更すると：
 * 1. 新しい Service Worker がインストールされる
 * 2. 古いキャッシュが削除される（アクティベート時）
 * 3. 新しいアセットがキャッシュされる
 * 4. 次回アクセスから新しいバージョンが使用される
 */

/**
 * キャッシュバージョン識別子。
 * アプリを更新したらこの値をインクリメントする（v1, v2, v3...）。
 * バージョンが変わると古いキャッシュが自動削除され、新しいファイルが
 * キャッシュに格納される（ユーザーは常に最新版を受け取る）。
 * @type {string}
 */
const CACHE_VERSION = 'v6';

/**
 * このService Workerが使用するキャッシュストレージの名前。
 * CacheStorage API では複数のキャッシュを名前で管理できる。
 * @type {string}
 */
const CACHE_NAME = `pwa-mp3-player-${CACHE_VERSION}`;

/**
 * インストール時にプリキャッシュする静的アセット一覧。
 * これらは全てネットワークから取得してキャッシュに保存される。
 * アプリのシェル（最低限動作するファイル群）のみを含める。
 *
 * 含めないもの:
 * - MP3ファイル（IndexedDBで管理）
 * - 動的に生成されるデータ
 * @type {string[]}
 */
const STATIC_ASSETS = [
  './',                      // ルートURL（index.htmlへのエイリアス）
  './index.html',            // メインHTML
  './style.css',             // スタイルシート
  './app.js',                // メインアプリケーションロジック
  './wasm-audio.js',         // WebAssemblyオーディオ処理モジュール
  './audio-processor.js',    // AudioWorkletプロセッサ
  './manifest.json',         // PWAマニフェスト
  './icons/icon-192.png',    // アプリアイコン（192×192: Android/Chrome用）
  './icons/icon-512.png',    // アプリアイコン（512×512: スプラッシュ画面用）
];

// ============================================================
// インストールイベント
//
// Service Workerが初めてページに登録されたとき（または新バージョン検出時）に
// 一度だけ発火する。ここで全静的アセットをキャッシュに保存する。
//
// skipWaiting() により待機なしで即座にアクティブ化する。
// （通常は古いService Workerが制御を手放すまで待機が必要）
// ============================================================
self.addEventListener('install', (event) => {
  console.log('[SW] インストール中...');

  event.waitUntil(
    // キャッシュストレージをオープン（存在しなければ新規作成）
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[SW] 静的アセットをキャッシュ中...', STATIC_ASSETS);
        // addAll: 全URLを並列フェッチしてキャッシュに保存
        // 1つでも失敗するとインストール全体が失敗する
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('[SW] インストール完了');
        // 通常は古いService Workerが制御を手放すまで待機するが、
        // skipWaiting() で強制的に即座にアクティブ化する
        // （ページリロード不要で新しいService Workerが有効になる）
        return self.skipWaiting();
      })
      .catch((err) => {
        console.error('[SW] インストール失敗:', err);
      })
  );
});

// ============================================================
// アクティベートイベント
//
// インストール後に Service Worker が「アクティブ」になるときに発火する。
// ここで古いバージョンのキャッシュを削除してストレージを節約する。
//
// clients.claim() により、現在開かれているページを即座に制御下に置く。
// （通常は次回ナビゲーション時から有効になる）
// ============================================================
self.addEventListener('activate', (event) => {
  console.log('[SW] アクティベート中...');

  event.waitUntil(
    // 現在存在する全キャッシュ名を取得
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            // このアプリのキャッシュ（pwa-mp3-player-で始まる）で
            // かつ現在のバージョン以外のものを削除対象にする
            .filter((name) =>
              name !== CACHE_NAME && name.startsWith('pwa-mp3-player-')
            )
            .map((name) => {
              console.log(`[SW] 古いキャッシュを削除: ${name}`);
              return caches.delete(name);
            })
        );
      })
      .then(() => {
        console.log('[SW] アクティベート完了');
        // 現在開かれている全ページをこのService Workerの制御下に置く
        // これにより、ページリロードなしに新しいService Workerが有効になる
        return self.clients.claim();
      })
  );
});

// ============================================================
// フェッチイベント（Cache First 戦略）
//
// ブラウザがネットワークリクエストを行うたびに発火する。
// Service Worker がリクエストを横取りし、キャッシュから返すか
// ネットワークから取得するかを制御する。
// ============================================================
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // ============================================================
  // 対象外リクエストの除外
  // ============================================================

  // GETリクエスト以外（POST, PUT, DELETEなど）は Service Worker でハンドルしない
  // IndexedDB の読み書きなどは別の仕組みで行われるため問題なし
  if (request.method !== 'GET') return;

  // http/https 以外のURL（chrome-extension://, data: など）は無視
  if (!request.url.startsWith('http')) return;

  // ============================================================
  // Cache First 戦略の実装
  // ============================================================
  event.respondWith(
    caches.match(request)
      .then((cachedResponse) => {
        // --- キャッシュヒット: キャッシュから即座に返す ---
        if (cachedResponse) {
          // ネットワーク通信なしで即座に応答（オフライン時も有効）
          return cachedResponse;
        }

        // --- キャッシュミス: ネットワークから取得 ---
        return fetch(request)
          .then((networkResponse) => {
            // 正常なレスポンス（200 OK かつ same-origin）のみキャッシュに保存
            // 不正なレスポンス・クロスオリジン・エラーレスポンスはキャッシュしない
            if (
              networkResponse &&
              networkResponse.status === 200 &&
              networkResponse.type === 'basic' // same-originのみ（CDNなどは除外）
            ) {
              // レスポンスはStreamなので、キャッシュ保存用にcloneする
              // （Streamは一度しか読めないため）
              const responseToCache = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, responseToCache);
              });
            }
            return networkResponse;
          })
          .catch(() => {
            // ============================================================
            // オフライン時のフォールバック処理
            // ネットワーク取得に失敗し、かつキャッシュにもない場合
            // ============================================================

            // ナビゲーションリクエスト（ページ遷移）なら index.html を返す
            // → SPA（シングルページアプリ）として動作させるため
            if (request.mode === 'navigate') {
              return caches.match('./index.html');
            }

            // それ以外のリソース（JS, CSS, 画像など）は 503 エラーを返す
            return new Response('オフラインです', {
              status: 503,
              statusText: 'Service Unavailable',
              headers: new Headers({
                'Content-Type': 'text/plain; charset=utf-8',
              }),
            });
          });
      })
  );
});
