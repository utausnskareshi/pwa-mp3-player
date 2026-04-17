/**
 * PWA MP3 Player - メインアプリケーション
 *
 * 機能:
 * - IndexedDBによるMP3ファイルの永続保存（オフライン再生対応）
 * - Web Audio API + AudioWorklet によるオーディオ再生
 * - WebAssembly によるスペクトラム解析・レベルメーター
 * - Media Session API によるロック画面コントロール
 * - プレイリスト管理（並び替え・削除）
 */

// ============================================================
// ID3v2 タグからアートワーク（APICフレーム）を抽出するユーティリティ
//
// ID3v2 ヘッダ構造 (10バイト):
//   "ID3" (3B) / version(2B) / flags(1B) / size(4B synchsafe)
// APICフレーム (v2.3/v2.4):
//   frameID(4B) / size(4B) / flags(2B) /
//   [text encoding(1B), mime(null終端), picture type(1B), description(null終端), 画像データ]
// PICフレーム (v2.2):
//   frameID(3B) / size(3B) /
//   [encoding(1B), image format 3B, picture type(1B), description(null終端), 画像データ]
//
// 解析に失敗した場合や見つからない場合は null を返す。
// ============================================================
/**
 * MP3ファイルのArrayBufferからアートワーク画像を抽出する。
 * @param {ArrayBuffer} arrayBuffer - MP3バイナリ
 * @returns {{mimeType: string, data: Uint8Array}|null} アートワーク情報 / 見つからない場合null
 */
function extractArtwork(arrayBuffer) {
  try {
    const view = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);

    // "ID3" マジックナンバーの確認
    if (bytes.length < 10) return null;
    if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;

    const majorVersion = bytes[3]; // 2, 3, 4 のいずれか
    // size はsynchsafe integer（各バイトの最上位ビットを無視した28bit値）
    const tagSize = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14)
                  | ((bytes[8] & 0x7f) << 7)  | (bytes[9] & 0x7f);
    const tagEnd = Math.min(10 + tagSize, bytes.length);

    let offset = 10;
    while (offset < tagEnd) {
      // v2.2 は3文字ID/3Bサイズ、v2.3/v2.4 は4文字ID/4Bサイズ
      if (majorVersion === 2) {
        if (offset + 6 > tagEnd) break;
        const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2]);
        const frameSize = (bytes[offset + 3] << 16) | (bytes[offset + 4] << 8) | bytes[offset + 5];
        if (frameSize <= 0 || offset + 6 + frameSize > tagEnd) break;
        if (id === 'PIC') {
          // PIC: encoding(1B) + format(3B) + picType(1B) + desc(null終端) + data
          const frameStart = offset + 6;
          const encoding = bytes[frameStart];
          const formatCode = String.fromCharCode(
            bytes[frameStart + 1], bytes[frameStart + 2], bytes[frameStart + 3]
          ).toLowerCase();
          const mimeType = formatCode === 'png' ? 'image/png' : 'image/jpeg';
          // description (null終端をスキップ)
          let descEnd = frameStart + 5;
          if (encoding === 1) {
            // UTF-16: 二重null終端
            while (descEnd + 1 < frameStart + frameSize
                   && !(bytes[descEnd] === 0 && bytes[descEnd + 1] === 0)) descEnd += 2;
            descEnd += 2;
          } else {
            while (descEnd < frameStart + frameSize && bytes[descEnd] !== 0) descEnd++;
            descEnd += 1;
          }
          const dataStart = descEnd;
          const dataEnd = frameStart + frameSize;
          if (dataEnd > dataStart && dataEnd <= bytes.length) {
            return { mimeType, data: bytes.slice(dataStart, dataEnd) };
          }
        }
        offset += 6 + frameSize;
      } else {
        if (offset + 10 > tagEnd) break;
        const id = String.fromCharCode(
          bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]
        );
        // v2.4 はsynchsafe、v2.3 は通常の32bit
        let frameSize;
        if (majorVersion === 4) {
          frameSize = ((bytes[offset + 4] & 0x7f) << 21) | ((bytes[offset + 5] & 0x7f) << 14)
                    | ((bytes[offset + 6] & 0x7f) << 7)  | (bytes[offset + 7] & 0x7f);
        } else {
          frameSize = view.getUint32(offset + 4, false);
        }
        if (frameSize <= 0 || offset + 10 + frameSize > tagEnd) break;
        if (id === 'APIC') {
          const frameStart = offset + 10;
          const frameEnd = frameStart + frameSize;
          const encoding = bytes[frameStart];
          // MIME type (null終端ASCII)
          let p = frameStart + 1;
          let mimeStart = p;
          while (p < frameEnd && bytes[p] !== 0) p++;
          const mimeType = new TextDecoder('ascii').decode(bytes.slice(mimeStart, p)) || 'image/jpeg';
          p += 1; // null終端をスキップ
          if (p >= frameEnd) { offset += 10 + frameSize; continue; }
          // picture type (1B)
          p += 1;
          // description (encoding依存の終端)
          if (encoding === 1 || encoding === 2) {
            // UTF-16系: 二重null終端
            while (p + 1 < frameEnd && !(bytes[p] === 0 && bytes[p + 1] === 0)) p += 2;
            p += 2;
          } else {
            while (p < frameEnd && bytes[p] !== 0) p++;
            p += 1;
          }
          if (p < frameEnd) {
            const data = bytes.slice(p, frameEnd);
            // MIMEが "-->" の場合はURL参照（未対応）
            if (mimeType.trim() !== '-->') {
              return { mimeType: mimeType.startsWith('image/') ? mimeType : `image/${mimeType}`, data };
            }
          }
        }
        offset += 10 + frameSize;
      }
    }
    return null;
  } catch (err) {
    console.warn('アートワーク抽出失敗:', err);
    return null;
  }
}

// ============================================================
// IndexedDB ストレージ管理
// ============================================================
class MusicStore {
  /** @type {string} データベース名 */
  static DB_NAME = 'pwa-mp3-player';
  /** @type {number} データベースバージョン（v3: artworkフィールド追加） */
  static DB_VERSION = 3;
  /** @type {string} オブジェクトストア名 */
  static STORE_NAME = 'tracks';

  constructor() {
    /** @type {IDBDatabase|null} */
    this.db = null;
  }

  /**
   * IndexedDBを初期化
   * @returns {Promise<void>}
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(MusicStore.DB_NAME, MusicStore.DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(MusicStore.STORE_NAME)) {
          // 新規作成
          const store = db.createObjectStore(MusicStore.STORE_NAME, { keyPath: 'id' });
          store.createIndex('name', 'name', { unique: false });
          store.createIndex('addedAt', 'addedAt', { unique: false });
          store.createIndex('order', 'order', { unique: false });
        } else {
          // 既存DBのマイグレーション
          const tx = event.target.transaction;
          const store = tx.objectStore(MusicStore.STORE_NAME);
          if (!store.indexNames.contains('order')) {
            store.createIndex('order', 'order', { unique: false });
          }
          // 全レコードを走査してフィールドの補完/アートワーク抽出を行う
          const cursorReq = store.openCursor();
          let idx = 0;
          cursorReq.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              const rec = cursor.value;
              let changed = false;
              // v1→v2: order/disabled
              if (rec.order === undefined) { rec.order = rec.addedAt || idx; changed = true; }
              if (rec.disabled === undefined) { rec.disabled = false; changed = true; }
              // v2→v3: 既存トラックからアートワークを抽出
              if (rec.artwork === undefined && rec.data) {
                const art = extractArtwork(rec.data);
                rec.artwork = art; // {mimeType, data} または null
                changed = true;
              }
              if (changed) cursor.update(rec);
              idx++;
              cursor.continue();
            }
          };
        }
      };
      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve();
      };
      request.onerror = (event) => {
        reject(new Error(`IndexedDB初期化エラー: ${event.target.error}`));
      };
    });
  }

  /**
   * MP3ファイルを保存
   * @param {File} file - MP3ファイル
   * @returns {Promise<object>} 保存されたトラック情報
   */
  async addTrack(file) {
    // 現在の最大orderを取得して末尾に追加
    const existing = await this.getAllTracks();
    const maxOrder = existing.reduce((max, t) => Math.max(max, t.order || 0), 0);

    const arrayBuffer = await file.arrayBuffer();
    // ID3v2タグからアートワークを抽出（見つからなければnull）
    const artwork = extractArtwork(arrayBuffer);
    const track = {
      id: `track_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: file.name.replace(/\.mp3$/i, ''),
      fileName: file.name,
      size: file.size,
      type: file.type || 'audio/mpeg',
      data: arrayBuffer,
      artwork, // {mimeType: string, data: Uint8Array} または null
      addedAt: Date.now(),
      order: maxOrder + 1,
      disabled: false,
    };
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(MusicStore.STORE_NAME, 'readwrite');
      const store = tx.objectStore(MusicStore.STORE_NAME);
      const request = store.put(track);
      request.onsuccess = () => resolve(track);
      request.onerror = (event) => reject(new Error(`保存エラー: ${event.target.error}`));
    });
  }

  /**
   * 全トラックのメタデータを取得（データ本体は除外）
   * @returns {Promise<object[]>}
   */
  async getAllTracks() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(MusicStore.STORE_NAME, 'readonly');
      const store = tx.objectStore(MusicStore.STORE_NAME);
      const request = store.getAll();
      request.onsuccess = (event) => {
        const tracks = event.target.result.map(t => ({
          id: t.id,
          name: t.name,
          fileName: t.fileName,
          size: t.size,
          addedAt: t.addedAt,
          order: t.order !== undefined ? t.order : t.addedAt,
          disabled: !!t.disabled,
          artwork: t.artwork || null, // アートワーク情報をそのまま渡す
        }));
        // orderでソート
        tracks.sort((a, b) => a.order - b.order);
        resolve(tracks);
      };
      request.onerror = (event) => reject(new Error(`取得エラー: ${event.target.error}`));
    });
  }

  /**
   * トラックのオーディオデータを取得
   * @param {string} id - トラックID
   * @returns {Promise<ArrayBuffer>}
   */
  async getTrackData(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(MusicStore.STORE_NAME, 'readonly');
      const store = tx.objectStore(MusicStore.STORE_NAME);
      const request = store.get(id);
      request.onsuccess = (event) => {
        if (event.target.result) {
          resolve(event.target.result.data);
        } else {
          reject(new Error('トラックが見つかりません'));
        }
      };
      request.onerror = (event) => reject(new Error(`取得エラー: ${event.target.error}`));
    });
  }

  /**
   * トラックを削除
   * @param {string} id - トラックID
   * @returns {Promise<void>}
   */
  async deleteTrack(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(MusicStore.STORE_NAME, 'readwrite');
      const store = tx.objectStore(MusicStore.STORE_NAME);
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = (event) => reject(new Error(`削除エラー: ${event.target.error}`));
    });
  }

  /**
   * トラックのメタデータを部分更新（order, disabled等）
   * データ本体(data)は変更せずにメタ情報だけ更新する
   * @param {string} id - トラックID
   * @param {object} fields - 更新するフィールド
   * @returns {Promise<void>}
   */
  async updateTrack(id, fields) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(MusicStore.STORE_NAME, 'readwrite');
      const store = tx.objectStore(MusicStore.STORE_NAME);
      const getReq = store.get(id);
      getReq.onsuccess = (event) => {
        const record = event.target.result;
        if (!record) { reject(new Error('トラックが見つかりません')); return; }
        Object.assign(record, fields);
        const putReq = store.put(record);
        putReq.onsuccess = () => resolve();
        putReq.onerror = (e) => reject(new Error(`更新エラー: ${e.target.error}`));
      };
      getReq.onerror = (event) => reject(new Error(`取得エラー: ${event.target.error}`));
    });
  }

  /**
   * 複数トラックのorderを一括更新
   * @param {Array<{id: string, order: number}>} orderList
   * @returns {Promise<void>}
   */
  async reorderTracks(orderList) {
    const tx = this.db.transaction(MusicStore.STORE_NAME, 'readwrite');
    const store = tx.objectStore(MusicStore.STORE_NAME);
    for (const { id, order } of orderList) {
      const getReq = store.get(id);
      await new Promise((resolve, reject) => {
        getReq.onsuccess = (event) => {
          const record = event.target.result;
          if (record) {
            record.order = order;
            store.put(record);
          }
          resolve();
        };
        getReq.onerror = () => resolve();
      });
    }
    return new Promise((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
}

// ============================================================
// オーディオエンジン
// <audio>要素ベースの実装（iOSバックグラウンド再生対応）
//
// 【設計】
// - 音声出力: <audio>要素が直接担当（AudioContext不使用 → ロック画面でも継続）
// - 解析用:   同じMP3を decodeAudioData() で別途デコードしPCMデータを保持。
//             再生位置に合わせてPCMサンプルを切り出し、Wasmで解析。
//             AudioContextを音声経路に介在させないためバックグラウンド再生に影響なし。
// ============================================================
class AudioEngine {
  constructor() {
    /** @type {HTMLAudioElement} 再生の主体となるaudio要素 */
    this.audioEl = document.createElement('audio');
    /** @type {AudioContext|null} デコード専用（音声出力には使わない） */
    this._decodeCtx = null;
    /** @type {AudioBuffer|null} デコード済みPCMデータ（解析用） */
    this.pcmBuffer = null;
    /** @type {WasmAudioProcessor|null} Wasmプロセッサ */
    this.wasmProcessor = null;
    /** @type {'stopped'|'playing'|'paused'} 再生状態 */
    this.state = 'stopped';
    /** @type {number} ボリューム（0.0〜1.0） */
    this.volume = 1.0;
    /** @type {string|null} 現在のBlobURL（メモリリーク防止用） */
    this._currentBlobUrl = null;
    /** @type {Function|null} 再生完了コールバック */
    this.onEnded = null;
    /** @type {Function|null} レベルデータコールバック */
    this.onLevelData = null;

    // audio要素の基本設定
    this.audioEl.setAttribute('playsinline', '');
    this.audioEl.setAttribute('webkit-playsinline', '');
    this.audioEl.preload = 'auto';

    // 再生完了イベント
    this.audioEl.addEventListener('ended', () => {
      this.state = 'stopped';
      if (this.onEnded) this.onEnded();
    });

    // エラーハンドリング
    this.audioEl.addEventListener('error', (e) => {
      console.error('Audio要素エラー:', e);
      this.state = 'stopped';
    });
  }

  /**
   * オーディオエンジンを初期化
   * デコード用AudioContextとWasmプロセッサを準備
   */
  async init() {
    // デコード専用AudioContext（音声出力には一切使わない）
    this._decodeCtx = new (window.AudioContext || window.webkitAudioContext)();

    // Wasmプロセッサ初期化
    try {
      this.wasmProcessor = new WasmAudioProcessor();
      await this.wasmProcessor.init();
      console.log('WebAssemblyオーディオプロセッサ初期化完了');
    } catch (err) {
      console.warn('Wasmプロセッサ初期化失敗、JSフォールバック使用:', err);
      this.wasmProcessor = null;
    }
  }

  /**
   * AudioContextを再開（iOSではユーザー操作後に必要）
   */
  async resume() {
    if (this._decodeCtx && this._decodeCtx.state === 'suspended') {
      await this._decodeCtx.resume();
    }
  }

  /**
   * MP3データをロード
   * - BlobURLを生成し<audio>要素にセット（再生用）
   * - decodeAudioDataでPCMデコード（解析用）
   * @param {ArrayBuffer} arrayBuffer - MP3バイナリデータ
   */
  async loadAudio(arrayBuffer) {
    await this.resume();
    this.stop();

    // 前のBlobURLを解放
    if (this._currentBlobUrl) {
      URL.revokeObjectURL(this._currentBlobUrl);
      this._currentBlobUrl = null;
    }

    // --- 再生用: <audio>要素にBlobURLをセット ---
    const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
    this._currentBlobUrl = URL.createObjectURL(blob);
    this.audioEl.src = this._currentBlobUrl;
    this.audioEl.load();

    // --- 解析用: PCMデコード（AudioContextを音声出力には使わない） ---
    try {
      this.pcmBuffer = await this._decodeCtx.decodeAudioData(arrayBuffer.slice(0));
      console.log(`PCMデコード完了: ${this.pcmBuffer.duration.toFixed(1)}秒, ${this.pcmBuffer.numberOfChannels}ch`);
    } catch (err) {
      console.warn('PCMデコード失敗（解析なしで再生は継続）:', err);
      this.pcmBuffer = null;
    }

    // メタデータの読み込みを待つ
    await new Promise((resolve, reject) => {
      const onLoaded = () => {
        this.audioEl.removeEventListener('loadedmetadata', onLoaded);
        this.audioEl.removeEventListener('error', onError);
        resolve();
      };
      const onError = () => {
        this.audioEl.removeEventListener('loadedmetadata', onLoaded);
        this.audioEl.removeEventListener('error', onError);
        reject(new Error('オーディオの読み込みに失敗しました'));
      };
      // 既にメタデータが読み込まれている場合
      if (this.audioEl.readyState >= 1) {
        resolve();
        return;
      }
      this.audioEl.addEventListener('loadedmetadata', onLoaded);
      this.audioEl.addEventListener('error', onError);
    });
  }

  /**
   * 再生開始
   * @param {number} offset - 開始位置（秒）
   */
  async play(offset = 0) {
    if (!this.audioEl.src) return;
    await this.resume();

    if (offset !== undefined && isFinite(offset)) {
      this.audioEl.currentTime = offset;
    }

    try {
      await this.audioEl.play();
      this.state = 'playing';
    } catch (err) {
      console.error('再生開始エラー:', err);
    }
  }

  /** 一時停止 */
  pause() {
    if (this.state !== 'playing') return;
    this.audioEl.pause();
    this.state = 'paused';
  }

  /** 停止 */
  stop() {
    this.audioEl.pause();
    if (this.audioEl.src) {
      this.audioEl.currentTime = 0;
    }
    this.state = 'stopped';
  }

  /** 再生/一時停止トグル */
  async togglePlayPause() {
    if (this.state === 'playing') {
      this.pause();
    } else if (this.state === 'paused') {
      await this.play(this.audioEl.currentTime);
    } else if (this.audioEl.src) {
      await this.play(0);
    }
  }

  /** シーク @param {number} time 秒 */
  seek(time) {
    this.audioEl.currentTime = Math.max(0, Math.min(time, this.duration));
  }

  /** ボリューム設定 @param {number} value 0.0〜1.0 */
  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    this.audioEl.volume = this.volume;
  }

  /** 現在の再生位置（秒） */
  get currentTime() {
    return this.audioEl.currentTime || 0;
  }

  /** 総再生時間（秒） */
  get duration() {
    const d = this.audioEl.duration;
    return isFinite(d) ? d : 0;
  }

  // ============================================================
  // PCMバッファから現在の再生位置のサンプルを切り出す（解析の基盤）
  // ============================================================

  /**
   * 現在の再生位置周辺のPCMサンプルを取得
   * @param {number} sampleCount - 取得サンプル数
   * @returns {Float32Array} モノラルに変換されたサンプル
   */
  _getCurrentSamples(sampleCount = 2048) {
    if (!this.pcmBuffer || this.state !== 'playing') {
      return new Float32Array(sampleCount);
    }

    const sampleRate = this.pcmBuffer.sampleRate;
    const currentSample = Math.floor(this.currentTime * sampleRate);
    const totalSamples = this.pcmBuffer.length;
    const channels = this.pcmBuffer.numberOfChannels;

    // 開始位置（はみ出し防止）
    const start = Math.max(0, Math.min(currentSample, totalSamples - sampleCount));
    const end = Math.min(start + sampleCount, totalSamples);
    const actualLen = end - start;

    // チャンネル0のデータを取得
    const ch0 = this.pcmBuffer.getChannelData(0);
    const result = new Float32Array(sampleCount);

    // モノラルに変換（ステレオの場合は平均）
    if (channels >= 2) {
      const ch1 = this.pcmBuffer.getChannelData(1);
      for (let i = 0; i < actualLen; i++) {
        result[i] = (ch0[start + i] + ch1[start + i]) * 0.5;
      }
    } else {
      for (let i = 0; i < actualLen; i++) {
        result[i] = ch0[start + i];
      }
    }

    return result;
  }

  // ============================================================
  // 解析メソッド（PCMバッファ + Wasm で処理）
  // ============================================================

  /**
   * スペクトラムデータを取得（Wasm DFT）
   * @param {number} bins - ビン数
   * @returns {Float32Array}
   */
  getSpectrumData(bins = 64) {
    if (this.state !== 'playing' || !this.pcmBuffer) {
      return new Float32Array(bins);
    }

    const samples = this._getCurrentSamples(2048);

    // Wasmプロセッサが利用可能な場合
    if (this.wasmProcessor && this.wasmProcessor.ready) {
      return this.wasmProcessor.computeSpectrum(samples, bins);
    }

    // JSフォールバック: 簡易DFT
    const N = bins * 2;
    const buf = new Float32Array(N);
    const step = samples.length / N;
    for (let i = 0; i < N; i++) {
      buf[i] = samples[Math.floor(i * step)] || 0;
    }
    const magnitudes = new Float32Array(bins);
    let maxMag = 0;
    for (let k = 0; k < bins; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const angle = (2 * Math.PI * k * n) / N;
        re += buf[n] * Math.cos(angle);
        im -= buf[n] * Math.sin(angle);
      }
      const mag = Math.sqrt(re * re + im * im) / N;
      magnitudes[k] = mag;
      if (mag > maxMag) maxMag = mag;
    }
    if (maxMag > 0) {
      for (let k = 0; k < bins; k++) magnitudes[k] /= maxMag;
    }
    return magnitudes;
  }

  /**
   * RMSレベルを取得（Wasm高速化）
   * @returns {number}
   */
  getRMSLevel() {
    if (this.state !== 'playing' || !this.pcmBuffer) return 0;
    const samples = this._getCurrentSamples(2048);
    if (this.wasmProcessor && this.wasmProcessor.ready) {
      return this.wasmProcessor.computeRMS(samples);
    }
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  /**
   * ピークレベルを取得（Wasm高速化）
   * @returns {number}
   */
  getPeakLevel() {
    if (this.state !== 'playing' || !this.pcmBuffer) return 0;
    const samples = this._getCurrentSamples(2048);
    if (this.wasmProcessor && this.wasmProcessor.ready) {
      return this.wasmProcessor.computePeak(samples);
    }
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i]);
      if (abs > peak) peak = abs;
    }
    return peak;
  }
}

// ============================================================
// UIコントローラー
// ============================================================
class PlayerUI {
  constructor() {
    /** @type {MusicStore} */
    this.store = new MusicStore();
    /** @type {AudioEngine} */
    this.engine = new AudioEngine();
    /** @type {object[]} プレイリスト */
    this.playlist = [];
    /** @type {number} 現在のトラックインデックス */
    this.currentIndex = -1;
    /** @type {string|null} 現在のトラックID */
    this.currentTrackId = null;
    /** @type {boolean} リピートモード */
    this.repeat = false;
    /** @type {boolean} シャッフルモード */
    this.shuffle = false;
    /** @type {number|null} アニメーションフレームID */
    this.animationFrameId = null;
    /** @type {boolean} シークバードラッグ中 */
    this.isSeeking = false;
    /** @type {CanvasRenderingContext2D|null} ビジュアライザーコンテキスト */
    this.vizCtx = null;
    /** @type {boolean} 初期化済みフラグ */
    this.initialized = false;
    /** @type {Map<string, string>} トラックID -> アートワークBlobURL（メモリリーク防止用） */
    this._artworkUrls = new Map();
  }

  /**
   * トラックのアートワークBlobURLを取得（キャッシュ）
   * @param {object} track
   * @returns {string|null} BlobURL / アートワークなしならnull
   */
  _getArtworkUrl(track) {
    if (!track.artwork || !track.artwork.data) return null;
    if (this._artworkUrls.has(track.id)) return this._artworkUrls.get(track.id);
    try {
      const blob = new Blob([track.artwork.data], { type: track.artwork.mimeType || 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      this._artworkUrls.set(track.id, url);
      return url;
    } catch (err) {
      console.warn('アートワークBlob生成失敗:', err);
      return null;
    }
  }

  /**
   * 不要になったアートワークBlobURLを解放
   * プレイリストに存在しないトラックIDのURLを破棄する
   */
  _cleanupArtworkUrls() {
    const aliveIds = new Set(this.playlist.map(t => t.id));
    for (const [id, url] of this._artworkUrls.entries()) {
      if (!aliveIds.has(id)) {
        URL.revokeObjectURL(url);
        this._artworkUrls.delete(id);
      }
    }
  }

  /**
   * アプリケーション初期化
   */
  async init() {
    try {
      // IndexedDB初期化
      await this.store.init();

      // UI要素のキャッシュ
      this._cacheElements();

      // イベントリスナー登録
      this._bindEvents();

      // プレイリスト読み込み
      await this._refreshPlaylist();

      // ビジュアライザー初期化
      this._initVisualizer();

      // インストールバナーの制御
      this._setupInstallPrompt();

      this.initialized = true;
      console.log('PWA MP3 Player 初期化完了');
    } catch (err) {
      console.error('初期化エラー:', err);
      this._showToast('初期化に失敗しました: ' + err.message, 'error');
    }
  }

  /**
   * DOM要素をキャッシュ
   */
  _cacheElements() {
    this.el = {
      // ファイル入力
      fileInput: document.getElementById('fileInput'),
      addButton: document.getElementById('addButton'),
      // プレイリスト
      playlistEl: document.getElementById('playlist'),
      trackCount: document.getElementById('trackCount'),
      // プレイヤーコントロール
      playPauseBtn: document.getElementById('playPauseBtn'),
      prevBtn: document.getElementById('prevBtn'),
      nextBtn: document.getElementById('nextBtn'),
      stopBtn: document.getElementById('stopBtn'),
      repeatBtn: document.getElementById('repeatBtn'),
      shuffleBtn: document.getElementById('shuffleBtn'),
      // 再生情報
      trackTitle: document.getElementById('trackTitle'),
      currentTimeEl: document.getElementById('currentTime'),
      durationEl: document.getElementById('duration'),
      seekBar: document.getElementById('seekBar'),
      seekProgress: document.getElementById('seekProgress'),
      seekHandle: document.getElementById('seekHandle'),
      // ボリューム
      volumeSlider: document.getElementById('volumeSlider'),
      volumeIcon: document.getElementById('volumeIcon'),
      // ビジュアライザー
      visualizer: document.getElementById('visualizer'),
      // レベルメーター
      rmsLevel: document.getElementById('rmsLevel'),
      peakLevel: document.getElementById('peakLevel'),
      // ステータス
      wasmStatus: document.getElementById('wasmStatus'),
      toast: document.getElementById('toast'),
    };
  }

  /**
   * イベントリスナーを登録
   */
  _bindEvents() {
    // ファイル追加
    this.el.addButton.addEventListener('click', () => this.el.fileInput.click());
    this.el.fileInput.addEventListener('change', (e) => this._handleFileSelect(e));

    // 再生コントロール
    this.el.playPauseBtn.addEventListener('click', () => this._togglePlayPause());
    this.el.prevBtn.addEventListener('click', () => this._prevTrack());
    this.el.nextBtn.addEventListener('click', () => this._nextTrack());
    this.el.stopBtn.addEventListener('click', () => this._stopPlayback());
    this.el.repeatBtn.addEventListener('click', () => this._toggleRepeat());
    this.el.shuffleBtn.addEventListener('click', () => this._toggleShuffle());

    // シークバー
    this._setupSeekBar();

    // ボリューム
    this.el.volumeSlider.addEventListener('input', (e) => {
      const vol = parseFloat(e.target.value);
      this.engine.setVolume(vol);
      this._updateVolumeIcon(vol);
    });
    this.el.volumeIcon.addEventListener('click', () => {
      const slider = this.el.volumeSlider;
      if (parseFloat(slider.value) > 0) {
        slider.dataset.prevValue = slider.value;
        slider.value = 0;
        this.engine.setVolume(0);
      } else {
        slider.value = slider.dataset.prevValue || 1;
        this.engine.setVolume(parseFloat(slider.value));
      }
      this._updateVolumeIcon(parseFloat(slider.value));
    });

    // 再生完了コールバック
    this.engine.onEnded = () => this._onTrackEnded();

    // ドラッグ＆ドロップ対応
    document.body.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      document.body.classList.add('drag-over');
    });
    document.body.addEventListener('dragleave', () => {
      document.body.classList.remove('drag-over');
    });
    document.body.addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('drag-over');
      const files = [...e.dataTransfer.files].filter(f =>
        f.type === 'audio/mpeg' || f.name.toLowerCase().endsWith('.mp3')
      );
      if (files.length > 0) this._importFiles(files);
    });
  }

  /**
   * シークバーのタッチ/マウスイベント設定
   */
  _setupSeekBar() {
    const seekBar = this.el.seekBar;

    const getPositionRatio = (e) => {
      const rect = seekBar.getBoundingClientRect();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    };

    const onStart = (e) => {
      e.preventDefault();
      this.isSeeking = true;
      const ratio = getPositionRatio(e);
      this._updateSeekVisual(ratio);
    };

    const onMove = (e) => {
      if (!this.isSeeking) return;
      e.preventDefault();
      const ratio = getPositionRatio(e);
      this._updateSeekVisual(ratio);
    };

    const onEnd = (e) => {
      if (!this.isSeeking) return;
      this.isSeeking = false;
      const rect = seekBar.getBoundingClientRect();
      const clientX = e.changedTouches ? e.changedTouches[0].clientX : e.clientX;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const seekTime = ratio * this.engine.duration;
      this.engine.seek(seekTime);
    };

    // マウスイベント
    seekBar.addEventListener('mousedown', onStart);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);

    // タッチイベント
    seekBar.addEventListener('touchstart', onStart, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  }

  /**
   * シークバーのビジュアルを更新
   * @param {number} ratio - 0.0〜1.0
   */
  _updateSeekVisual(ratio) {
    const pct = ratio * 100;
    this.el.seekProgress.style.width = `${pct}%`;
    this.el.seekHandle.style.left = `${pct}%`;
    this.el.currentTimeEl.textContent = this._formatTime(ratio * this.engine.duration);
  }

  /**
   * ファイル選択ハンドラ
   * @param {Event} event
   */
  async _handleFileSelect(event) {
    const files = [...event.target.files].filter(f =>
      f.type === 'audio/mpeg' || f.name.toLowerCase().endsWith('.mp3')
    );
    if (files.length === 0) {
      this._showToast('MP3ファイルを選択してください', 'warn');
      return;
    }
    await this._importFiles(files);
    // inputをリセット
    event.target.value = '';
  }

  /**
   * ファイルをIndexedDBにインポート
   * @param {File[]} files
   */
  async _importFiles(files) {
    this._showToast(`${files.length}件のファイルを取り込み中...`, 'info');
    let imported = 0;
    for (const file of files) {
      try {
        await this.store.addTrack(file);
        imported++;
      } catch (err) {
        console.error(`インポートエラー (${file.name}):`, err);
      }
    }
    await this._refreshPlaylist();
    this._showToast(`${imported}件のファイルを取り込みました`, 'success');
  }

  /**
   * プレイリストを更新
   */
  async _refreshPlaylist() {
    this.playlist = await this.store.getAllTracks();
    // 削除されたトラックのアートワークURLを解放
    this._cleanupArtworkUrls();
    this._renderPlaylist();
    const enabledCount = this.playlist.filter(t => !t.disabled).length;
    this.el.trackCount.textContent = `${enabledCount}/${this.playlist.length}曲`;
  }

  /**
   * プレイリストをレンダリング
   * - ドラッグハンドル（並び替え用）
   * - 無効化トグルボタン
   * - 削除ボタン
   */
  _renderPlaylist() {
    const el = this.el.playlistEl;
    el.innerHTML = '';

    if (this.playlist.length === 0) {
      el.innerHTML = `
        <div class="empty-playlist">
          <div class="empty-icon">🎵</div>
          <p>MP3ファイルを追加してください</p>
          <p class="empty-hint">「＋ファイルを追加」ボタンまたは<br>ドラッグ＆ドロップで追加できます</p>
        </div>
      `;
      return;
    }

    this.playlist.forEach((track, index) => {
      const item = document.createElement('div');
      const classes = ['playlist-item'];
      if (this.currentTrackId === track.id) classes.push('active');
      if (track.disabled) classes.push('disabled');
      item.className = classes.join(' ');
      item.dataset.index = index;
      item.dataset.trackId = track.id;
      // ネイティブD&D属性
      item.draggable = true;

      const sizeStr = this._formatFileSize(track.size);
      // アートワーク（ID3v2 APIC）があればサムネイル、なければ音符プレースホルダー
      const artworkUrl = this._getArtworkUrl(track);
      const artworkHtml = artworkUrl
        ? `<img class="track-artwork" src="${artworkUrl}" alt="" loading="lazy">`
        : `<div class="track-artwork track-artwork--placeholder"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z"/></svg></div>`;
      // 無効化トグルアイコン（有効＝スピーカーON / 無効＝スピーカーOFF）
      const toggleIcon = track.disabled
        ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>'
        : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg>';
      const toggleTitle = track.disabled ? '再生を有効にする' : '再生を無効にする';

      item.innerHTML = `
        <div class="drag-handle" data-action="drag" title="ドラッグして並び替え">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/>
            <circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/>
            <circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/>
          </svg>
        </div>
        <div class="track-info" data-action="play" data-index="${index}">
          <span class="track-number">${index + 1}</span>
          ${artworkHtml}
          <div class="track-details">
            <span class="track-name">${this._escapeHtml(track.name)}</span>
            <span class="track-meta">${sizeStr}</span>
          </div>
        </div>
        <button class="track-toggle" data-action="toggle" data-id="${track.id}" title="${toggleTitle}">
          ${toggleIcon}
        </button>
        <button class="track-delete" data-action="delete" data-id="${track.id}" title="削除">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
          </svg>
        </button>
      `;

      // トラック再生イベント
      item.querySelector('[data-action="play"]').addEventListener('click', () => {
        if (track.disabled) {
          this._showToast('このトラックは無効化されています', 'warn');
          return;
        }
        this._playTrackAtIndex(index);
      });

      // 無効化トグルイベント
      item.querySelector('[data-action="toggle"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        await this._toggleTrackDisabled(track.id, !track.disabled);
      });

      // 削除イベント
      item.querySelector('[data-action="delete"]').addEventListener('click', async (e) => {
        e.stopPropagation();
        await this._deleteTrack(track.id, index);
      });

      // --- ドラッグ＆ドロップによる並び替え ---
      item.addEventListener('dragstart', (e) => {
        item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', index.toString());
        // ドラッグ中の半透明
        requestAnimationFrame(() => item.classList.add('drag-ghost'));
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging', 'drag-ghost');
        // ドロップインジケーターをすべて除去
        el.querySelectorAll('.drop-above, .drop-below').forEach(
          el => el.classList.remove('drop-above', 'drop-below')
        );
      });
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        // 上半分にホバー → 上に挿入 / 下半分 → 下に挿入
        item.classList.remove('drop-above', 'drop-below');
        if (e.clientY < midY) {
          item.classList.add('drop-above');
        } else {
          item.classList.add('drop-below');
        }
      });
      item.addEventListener('dragleave', () => {
        item.classList.remove('drop-above', 'drop-below');
      });
      item.addEventListener('drop', async (e) => {
        e.preventDefault();
        item.classList.remove('drop-above', 'drop-below');
        const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10);
        const rect = item.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        let toIndex = e.clientY < midY ? index : index + 1;
        if (fromIndex === toIndex || fromIndex + 1 === toIndex) return; // 移動なし
        await this._moveTrack(fromIndex, toIndex);
      });

      // --- タッチ長押しによる並び替え ---
      this._setupTouchDrag(item, index, el);

      el.appendChild(item);
    });
  }

  /**
   * タッチデバイス向けの長押し並び替え
   * @param {HTMLElement} item - プレイリスト行要素
   * @param {number} index - 現在のインデックス
   * @param {HTMLElement} container - プレイリストコンテナ
   */
  _setupTouchDrag(item, index, container) {
    let longPressTimer = null;
    let isDragging = false;
    let startY = 0;
    let clone = null;
    let dragIndex = index;

    const handle = item.querySelector('.drag-handle');
    if (!handle) return;

    handle.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY;
      longPressTimer = setTimeout(() => {
        isDragging = true;
        item.classList.add('dragging');
        // フローティングクローンを作成
        clone = item.cloneNode(true);
        clone.className = 'playlist-item drag-clone';
        clone.style.position = 'fixed';
        clone.style.left = '8px';
        clone.style.right = '8px';
        clone.style.top = `${startY - 24}px`;
        clone.style.zIndex = '500';
        clone.style.pointerEvents = 'none';
        document.body.appendChild(clone);
      }, 300);
    }, { passive: true });

    handle.addEventListener('touchmove', (e) => {
      if (!isDragging) {
        // 長押し判定中に動いたらキャンセル
        if (Math.abs(e.touches[0].clientY - startY) > 10) {
          clearTimeout(longPressTimer);
        }
        return;
      }
      e.preventDefault();
      const touchY = e.touches[0].clientY;
      if (clone) clone.style.top = `${touchY - 24}px`;

      // ドロップ先のハイライト
      container.querySelectorAll('.playlist-item').forEach(el => {
        el.classList.remove('drop-above', 'drop-below');
        const rect = el.getBoundingClientRect();
        if (touchY > rect.top && touchY < rect.bottom) {
          const mid = rect.top + rect.height / 2;
          el.classList.add(touchY < mid ? 'drop-above' : 'drop-below');
        }
      });
    }, { passive: false });

    const endDrag = async (e) => {
      clearTimeout(longPressTimer);
      if (!isDragging) return;
      isDragging = false;
      item.classList.remove('dragging');
      if (clone) { clone.remove(); clone = null; }

      // ドロップ先を判定
      const touchY = e.changedTouches[0].clientY;
      const items = [...container.querySelectorAll('.playlist-item')];
      items.forEach(el => el.classList.remove('drop-above', 'drop-below'));

      let toIndex = index;
      for (let i = 0; i < items.length; i++) {
        const rect = items[i].getBoundingClientRect();
        if (touchY > rect.top && touchY < rect.bottom) {
          const mid = rect.top + rect.height / 2;
          toIndex = touchY < mid ? i : i + 1;
          break;
        }
      }
      if (index !== toIndex && index + 1 !== toIndex) {
        await this._moveTrack(index, toIndex);
      }
    };

    handle.addEventListener('touchend', endDrag);
    handle.addEventListener('touchcancel', () => {
      clearTimeout(longPressTimer);
      isDragging = false;
      item.classList.remove('dragging');
      if (clone) { clone.remove(); clone = null; }
      container.querySelectorAll('.drop-above, .drop-below').forEach(
        el => el.classList.remove('drop-above', 'drop-below')
      );
    });
  }

  /**
   * トラックの並び順を移動（IndexedDBに永続化）
   * @param {number} fromIndex - 移動元インデックス
   * @param {number} toIndex - 移動先インデックス
   */
  async _moveTrack(fromIndex, toIndex) {
    // 配列を操作
    const moved = this.playlist.splice(fromIndex, 1)[0];
    const insertAt = fromIndex < toIndex ? toIndex - 1 : toIndex;
    this.playlist.splice(insertAt, 0, moved);

    // 現在再生中のトラックのインデックスを更新
    if (this.currentTrackId) {
      this.currentIndex = this.playlist.findIndex(t => t.id === this.currentTrackId);
    }

    // orderフィールドを再採番してDB保存
    const orderList = this.playlist.map((t, i) => ({ id: t.id, order: i }));
    await this.store.reorderTracks(orderList);

    // 表示更新
    await this._refreshPlaylist();
    this._showToast('並び順を変更しました', 'info');
  }

  /**
   * トラックの無効化状態をトグル
   * @param {string} id
   * @param {boolean} disabled
   */
  async _toggleTrackDisabled(id, disabled) {
    await this.store.updateTrack(id, { disabled });

    // 再生中のトラックを無効化した場合は停止
    if (disabled && this.currentTrackId === id) {
      this._stopPlayback();
      this.currentTrackId = null;
      this.currentIndex = -1;
      this.el.trackTitle.textContent = 'トラック未選択';
    }

    await this._refreshPlaylist();
    this._showToast(disabled ? 'トラックを無効化しました' : 'トラックを有効化しました', 'info');
  }

  /**
   * 指定インデックスのトラックを再生
   * @param {number} index
   */
  async _playTrackAtIndex(index) {
    if (index < 0 || index >= this.playlist.length) return;

    const track = this.playlist[index];
    // 無効化されたトラックはスキップ
    if (track.disabled) {
      this._nextEnabledTrack(index);
      return;
    }
    this.currentIndex = index;
    this.currentTrackId = track.id;

    // UI更新
    this.el.trackTitle.textContent = track.name;
    this._renderPlaylist();
    this._showToast(`再生中: ${track.name}`, 'info');

    try {
      // AudioEngine初期化（初回のみ、ユーザー操作後に行う）
      if (!this.engine._decodeCtx) {
        await this.engine.init();
        // Wasmステータス更新
        if (this.engine.wasmProcessor && this.engine.wasmProcessor.ready) {
          this.el.wasmStatus.textContent = 'Wasm: Active';
          this.el.wasmStatus.classList.add('active');
        }
      }
      await this.engine.resume();

      // オーディオデータ取得・デコード
      const data = await this.store.getTrackData(track.id);
      await this.engine.loadAudio(data);

      // 再生開始
      await this.engine.play(0);
      this._updatePlayPauseButton();
      this.el.durationEl.textContent = this._formatTime(this.engine.duration);

      // Media Session更新
      this._updateMediaSession(track);

      // アニメーションループ開始
      this._startAnimationLoop();
    } catch (err) {
      console.error('再生エラー:', err);
      this._showToast('再生に失敗しました: ' + err.message, 'error');
    }
  }

  /**
   * 再生/一時停止切り替え
   */
  async _togglePlayPause() {
    if (!this.engine._decodeCtx) {
      // 未初期化の場合、最初の有効トラックを再生
      const enabled = this._getEnabledTracks();
      if (enabled.length > 0) {
        await this._playTrackAtIndex(enabled[0].index);
      }
      return;
    }
    await this.engine.resume();
    await this.engine.togglePlayPause();
    this._updatePlayPauseButton();
    if (this.engine.state === 'playing') {
      this._startAnimationLoop();
    }
  }

  /**
   * 有効なトラックのみのリストを返す
   * @returns {Array<{track: object, index: number}>}
   */
  _getEnabledTracks() {
    return this.playlist
      .map((track, index) => ({ track, index }))
      .filter(({ track }) => !track.disabled);
  }

  /**
   * 指定インデックスから次の有効トラックを再生
   * @param {number} fromIndex - 起点インデックス
   */
  _nextEnabledTrack(fromIndex) {
    const len = this.playlist.length;
    for (let i = 1; i <= len; i++) {
      const idx = (fromIndex + i) % len;
      if (!this.playlist[idx].disabled) {
        this._playTrackAtIndex(idx);
        return;
      }
    }
    // 全て無効の場合
    this._showToast('有効なトラックがありません', 'warn');
  }

  /**
   * 前のトラック（無効トラックをスキップ）
   */
  _prevTrack() {
    const enabled = this._getEnabledTracks();
    if (enabled.length === 0) return;
    // 再生位置が3秒以上なら先頭に戻す
    if (this.engine.currentTime > 3) {
      this.engine.seek(0);
      return;
    }
    // 現在位置から前方向の有効トラックを探す
    const len = this.playlist.length;
    for (let i = 1; i <= len; i++) {
      const idx = (this.currentIndex - i + len) % len;
      if (!this.playlist[idx].disabled) {
        this._playTrackAtIndex(idx);
        return;
      }
    }
  }

  /**
   * 次のトラック（無効トラックをスキップ）
   */
  _nextTrack() {
    const enabled = this._getEnabledTracks();
    if (enabled.length === 0) return;

    if (this.shuffle) {
      // シャッフル: 有効トラックからランダム選択
      const candidates = enabled.filter(({ index }) => index !== this.currentIndex);
      if (candidates.length === 0) {
        // 有効が1曲だけの場合はそれを再生
        this._playTrackAtIndex(enabled[0].index);
        return;
      }
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      this._playTrackAtIndex(pick.index);
    } else {
      // 通常: 次方向の有効トラックを探す
      this._nextEnabledTrack(this.currentIndex);
    }
  }

  /**
   * 停止
   */
  _stopPlayback() {
    this.engine.stop();
    this._updatePlayPauseButton();
    this._stopAnimationLoop();
    this._resetSeekBar();
  }

  /**
   * トラック再生完了時
   */
  _onTrackEnded() {
    if (this.repeat) {
      this._playTrackAtIndex(this.currentIndex);
    } else {
      const enabled = this._getEnabledTracks();
      // 現在のトラックが有効リスト内で最後かどうかチェック
      const currentEnabledIdx = enabled.findIndex(({ index }) => index === this.currentIndex);
      const hasNext = this.shuffle || currentEnabledIdx < enabled.length - 1;
      if (hasNext && enabled.length > 0) {
        this._nextTrack();
      } else {
        this._updatePlayPauseButton();
        this._stopAnimationLoop();
        this._resetSeekBar();
      }
    }
  }

  /**
   * リピートモード切替
   */
  _toggleRepeat() {
    this.repeat = !this.repeat;
    this.el.repeatBtn.classList.toggle('active', this.repeat);
  }

  /**
   * シャッフルモード切替
   */
  _toggleShuffle() {
    this.shuffle = !this.shuffle;
    this.el.shuffleBtn.classList.toggle('active', this.shuffle);
  }

  /**
   * トラック削除
   * @param {string} id
   * @param {number} index
   */
  async _deleteTrack(id, index) {
    // 再生中のトラックを削除する場合は停止
    if (this.currentTrackId === id) {
      this._stopPlayback();
      this.currentTrackId = null;
      this.currentIndex = -1;
      this.el.trackTitle.textContent = 'トラック未選択';
    } else if (index < this.currentIndex) {
      this.currentIndex--;
    }
    await this.store.deleteTrack(id);
    await this._refreshPlaylist();
    this._showToast('トラックを削除しました', 'info');
  }

  /**
   * 再生/一時停止ボタンの表示更新
   */
  _updatePlayPauseButton() {
    const btn = this.el.playPauseBtn;
    const isPlaying = this.engine.state === 'playing';
    btn.innerHTML = isPlaying
      ? '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
      : '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>';
    btn.setAttribute('aria-label', isPlaying ? '一時停止' : '再生');

    // Media Session状態更新
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }
  }

  /**
   * ボリュームアイコン更新
   * @param {number} vol
   */
  _updateVolumeIcon(vol) {
    const icon = this.el.volumeIcon;
    if (vol === 0) {
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
    } else if (vol < 0.5) {
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg>';
    } else {
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 010 14.14"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg>';
    }
  }

  /**
   * Media Session API設定（ロック画面コントロール）
   * @param {object} track
   */
  _updateMediaSession(track) {
    if (!('mediaSession' in navigator)) return;

    // アートワークがあればロック画面にも表示されるように渡す
    const artworkUrl = this._getArtworkUrl(track);
    const artworkList = artworkUrl
      ? [{ src: artworkUrl, sizes: '512x512', type: track.artwork.mimeType || 'image/jpeg' }]
      : [];

    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name,
      artist: 'PWA MP3 Player',
      album: 'ローカルライブラリ',
      artwork: artworkList,
    });

    navigator.mediaSession.setActionHandler('play', () => this._togglePlayPause());
    navigator.mediaSession.setActionHandler('pause', () => this._togglePlayPause());
    navigator.mediaSession.setActionHandler('previoustrack', () => this._prevTrack());
    navigator.mediaSession.setActionHandler('nexttrack', () => this._nextTrack());
    navigator.mediaSession.setActionHandler('stop', () => this._stopPlayback());

    try {
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime !== undefined) {
          this.engine.seek(details.seekTime);
        }
      });
    } catch (_) {
      // seekto非対応ブラウザでは無視
    }
  }

  // ============================================================
  // ビジュアライザー
  // ============================================================

  /**
   * ビジュアライザーキャンバスを初期化
   */
  _initVisualizer() {
    const canvas = this.el.visualizer;
    if (!canvas) return;
    this.vizCtx = canvas.getContext('2d');
    this._resizeCanvas();
    window.addEventListener('resize', () => this._resizeCanvas());
  }

  /**
   * キャンバスサイズをリサイズ
   */
  _resizeCanvas() {
    const canvas = this.el.visualizer;
    if (!canvas) return;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * (window.devicePixelRatio || 1);
    canvas.height = rect.height * (window.devicePixelRatio || 1);
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
  }

  /**
   * アニメーションループ開始
   */
  _startAnimationLoop() {
    if (this.animationFrameId) return;
    const loop = () => {
      this.animationFrameId = requestAnimationFrame(loop);
      this._updateUI();
    };
    loop();
  }

  /**
   * アニメーションループ停止
   */
  _stopAnimationLoop() {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  /**
   * UI更新（毎フレーム）
   */
  _updateUI() {
    // シークバー更新
    if (!this.isSeeking && this.engine.duration > 0) {
      const ratio = this.engine.currentTime / this.engine.duration;
      const pct = Math.min(ratio * 100, 100);
      this.el.seekProgress.style.width = `${pct}%`;
      this.el.seekHandle.style.left = `${pct}%`;
      this.el.currentTimeEl.textContent = this._formatTime(this.engine.currentTime);
    }

    // ビジュアライザー描画
    this._drawVisualizer();

    // レベルメーター更新
    this._updateLevelMeter();

    // Media Session位置情報更新（5フレームに1回）
    if (this._frameCount === undefined) this._frameCount = 0;
    this._frameCount++;
    if (this._frameCount % 30 === 0) {
      this._updateMediaSessionPosition();
    }
  }

  /**
   * ビジュアライザー描画
   */
  _drawVisualizer() {
    const ctx = this.vizCtx;
    if (!ctx) return;

    const canvas = ctx.canvas;
    const w = canvas.width;
    const h = canvas.height;

    // 背景クリア
    ctx.fillStyle = 'rgba(10, 10, 30, 0.3)';
    ctx.fillRect(0, 0, w, h);

    // スペクトラムデータ取得（Wasm処理）
    const bins = 64;
    const spectrum = this.engine.getSpectrumData(bins);

    const barWidth = (w / bins) * 0.8;
    const gap = (w / bins) * 0.2;

    for (let i = 0; i < bins; i++) {
      // 値を0-1に正規化（Wasmの出力に合わせて調整）
      let value = spectrum[i];
      if (value > 1) value = Math.min(value * 4, 1); // Wasm DFT出力のスケール調整
      const barHeight = value * h * 0.9;

      const x = i * (barWidth + gap);
      const y = h - barHeight;

      // グラデーションカラー
      const hue = 220 + (i / bins) * 60; // 青〜紫
      const lightness = 40 + value * 30;
      ctx.fillStyle = `hsl(${hue}, 80%, ${lightness}%)`;
      ctx.fillRect(x, y, barWidth, barHeight);

      // 頂点マーカー
      ctx.fillStyle = `hsl(${hue}, 90%, 70%)`;
      ctx.fillRect(x, y - 2, barWidth, 2);
    }
  }

  /**
   * レベルメーター更新
   */
  _updateLevelMeter() {
    const rms = this.engine.getRMSLevel();
    const peak = this.engine.getPeakLevel();

    // RMSをdBに変換（-60dB〜0dBの範囲で表示）
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -60;
    const peakDb = peak > 0 ? 20 * Math.log10(peak) : -60;

    const rmsPercent = Math.max(0, Math.min(100, ((rmsDb + 60) / 60) * 100));
    const peakPercent = Math.max(0, Math.min(100, ((peakDb + 60) / 60) * 100));

    if (this.el.rmsLevel) this.el.rmsLevel.style.width = `${rmsPercent}%`;
    if (this.el.peakLevel) this.el.peakLevel.style.width = `${peakPercent}%`;
  }

  /**
   * Media Session再生位置更新
   */
  _updateMediaSessionPosition() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (this.engine.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: this.engine.duration,
        playbackRate: 1,
        position: Math.min(this.engine.currentTime, this.engine.duration),
      });
    } catch (_) {
      // 無視
    }
  }

  /**
   * シークバーリセット
   */
  _resetSeekBar() {
    this.el.seekProgress.style.width = '0%';
    this.el.seekHandle.style.left = '0%';
    this.el.currentTimeEl.textContent = '0:00';
  }

  // ============================================================
  // PWAインストールプロンプト
  // ============================================================

  _setupInstallPrompt() {
    /** @type {Event|null} */
    this.deferredPrompt = null;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      const banner = document.getElementById('installBanner');
      if (banner) banner.classList.add('show');
    });

    const installBtn = document.getElementById('installBtn');
    if (installBtn) {
      installBtn.addEventListener('click', async () => {
        if (!this.deferredPrompt) return;
        this.deferredPrompt.prompt();
        await this.deferredPrompt.userChoice;
        this.deferredPrompt = null;
        const banner = document.getElementById('installBanner');
        if (banner) banner.classList.remove('show');
      });
    }

    const dismissBtn = document.getElementById('dismissInstall');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', () => {
        const banner = document.getElementById('installBanner');
        if (banner) banner.classList.remove('show');
      });
    }
  }

  // ============================================================
  // ユーティリティ
  // ============================================================

  /**
   * 秒数を mm:ss 形式にフォーマット
   * @param {number} seconds
   * @returns {string}
   */
  _formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * ファイルサイズをフォーマット
   * @param {number} bytes
   * @returns {string}
   */
  _formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /**
   * HTMLエスケープ
   * @param {string} str
   * @returns {string}
   */
  _escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * トースト通知を表示
   * @param {string} message
   * @param {'info'|'success'|'warn'|'error'} type
   */
  _showToast(message, type = 'info') {
    const toast = this.el.toast;
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    clearTimeout(this._toastTimeout);
    this._toastTimeout = setTimeout(() => {
      toast.classList.remove('show');
    }, 3000);
  }
}

// ============================================================
// アプリケーション起動
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  const app = new PlayerUI();
  app.init();

  // Service Worker登録
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      console.log('Service Worker登録完了:', reg.scope);
    }).catch((err) => {
      console.warn('Service Worker登録失敗:', err);
    });
  }
});
