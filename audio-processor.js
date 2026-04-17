/**
 * audio-processor.js - AudioWorklet プロセッサ
 *
 * 【概要】
 * Web Audio API の AudioWorklet として動作するオーディオ処理ノード。
 * メインスレッドとは独立した専用スレッドで実行されるため、
 * UIの処理がブロックされてもオーディオ処理は継続する。
 *
 * 【現在の利用状況】
 * このファイルはアーキテクチャの整理の過程で残っているが、
 * iOS バックグラウンド再生の問題解決のため、現在の本実装では
 * AudioWorklet を音声経路に介在させず、<audio>要素による直接再生を採用している。
 * 将来的なAndroid対応や音声処理拡張時に活用する可能性がある。
 *
 * 【AudioWorkletの動作フロー】
 * メインスレッド                  Workletスレッド
 *   │                                  │
 *   │ addModule('audio-processor.js') →│ スクリプト読み込み
 *   │                                  │ registerProcessor() 登録
 *   │                                  │
 *   │ new AudioWorkletNode(ctx, name) →│ AudioLevelProcessor()
 *   │                                  │   constructor 実行
 *   │                                  │
 *   │ ← port.onmessage ←──────────────│ this.port.postMessage()
 *   │   (levels: rms, peak, waveform)  │   レベルデータ送信
 *   │                                  │
 *   │ port.postMessage({type:'setGain'})│
 *   │ ──────────────────────────────→  │ port.onmessage 受信
 *   │                                  │   this.gain 更新
 *
 * 【使い方（将来利用時の参考）】
 *   await audioCtx.audioWorklet.addModule('./audio-processor.js');
 *   const node = new AudioWorkletNode(audioCtx, 'audio-level-processor');
 *   sourceNode.connect(node);
 *   node.connect(audioCtx.destination);
 *   node.port.onmessage = (e) => {
 *     console.log('RMS:', e.data.rms, 'Peak:', e.data.peak);
 *   };
 */

/**
 * AudioLevelProcessor - リアルタイムオーディオ解析ノード
 *
 * AudioWorkletProcessor を継承したカスタムプロセッサ。
 * 128サンプル（約2.9ms @ 44100Hz）ごとに process() が呼び出される。
 */
class AudioLevelProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    /** @type {number} ゲイン値（0.0 = ミュート, 1.0 = 等倍, 2.0 = +6dB） */
    this.gain = 1.0;

    /** @type {boolean} ミュート状態（trueのとき出力を0にする） */
    this.muted = false;

    /**
     * @type {number} スムージング済みRMS値
     * 急激な変化を滑らかにするため、前フレームの値と加重平均をとる。
     * 平滑化係数: 0.7（前フレーム） + 0.3（現フレーム）
     */
    this.smoothRMS = 0;

    /**
     * @type {number} ピーク値（減衰あり）
     * ピークは瞬時に跳ね上がるが、徐々に減衰（0.995倍/フレーム）する。
     * これにより「ピークホールド」の視覚効果が得られる。
     */
    this.peakHold = 0;

    /** @type {number} フレームカウンター（reportInterval の制御用） */
    this.frameCount = 0;

    /**
     * @type {number} 解析データをメインスレッドに送信する間隔（フレーム数）
     * 4 = 4×128サンプル = 512サンプルごと（約11.6ms @ 44100Hz）
     * 値を大きくするとCPU負荷が下がるが、メーターの反応が遅くなる。
     */
    this.reportInterval = 4;

    // ============================================================
    // メインスレッドからのメッセージ受信
    // node.port.postMessage({type, value}) で動的に設定変更を受け付ける
    // ============================================================
    this.port.onmessage = (event) => {
      const { type, value } = event.data;
      switch (type) {
        case 'setGain':
          // ゲイン変更（0.0〜∞、通常は0.0〜2.0）
          this.gain = value;
          break;
        case 'setMute':
          // ミュートのON/OFF
          this.muted = value;
          break;
        case 'setReportInterval':
          // 解析データの送信頻度変更
          this.reportInterval = value;
          break;
      }
    };
  }

  /**
   * オーディオ処理コールバック（128サンプルごとに自動呼び出し）
   *
   * AudioWorkletの中核メソッド。このメソッドが呼ばれる間隔は
   * サンプルレートに依存する（44100Hz なら約2.9ms間隔）。
   *
   * 処理内容:
   * 1. 全チャンネルにゲイン（音量倍率）を適用して出力バッファに書き込む
   * 2. 定期的にRMS・Peak・波形データを解析してメインスレッドに送信
   *
   * @param {Float32Array[][]} inputs
   *   inputs[nodeIndex][channelIndex][sampleIndex]
   *   - inputs[0] = 最初の入力ノードのチャンネル配列
   *   - inputs[0][0] = 左チャンネルの128サンプル
   *   - inputs[0][1] = 右チャンネルの128サンプル（ステレオの場合）
   *
   * @param {Float32Array[][]} outputs
   *   inputs と同じ構造。ここに書き込んだ値が出力される。
   *
   * @returns {boolean}
   *   true を返す限りノードが生き続ける。
   *   false を返すと（接続が切れた後に）ノードが自動削除される。
   */
  process(inputs, outputs) {
    const input = inputs[0];   // 最初の入力
    const output = outputs[0]; // 最初の出力

    // 入力がない場合（接続されていない）はスキップ
    if (!input || input.length === 0) return true;

    // ============================================================
    // ゲイン処理: 各チャンネルのサンプルに gain を乗算して出力
    // ============================================================
    for (let ch = 0; ch < input.length; ch++) {
      const inputChannel  = input[ch];
      const outputChannel = output[ch];

      if (!inputChannel || !outputChannel) continue;

      // ミュート時は gain を 0 に強制
      const effectiveGain = this.muted ? 0 : this.gain;

      for (let i = 0; i < inputChannel.length; i++) {
        outputChannel[i] = inputChannel[i] * effectiveGain;
      }
    }

    // ============================================================
    // 解析データの定期送信
    // reportInterval フレームごとにRMS・Peak・波形をメインスレッドへ送る
    // ============================================================
    this.frameCount++;
    if (this.frameCount >= this.reportInterval) {
      this.frameCount = 0;
      // 解析対象: 出力チャンネル0（ゲイン適用後の値）
      // 出力がない場合は入力をそのまま使用
      const channelData = output[0] || input[0];
      if (channelData) {
        this._analyzeAndReport(channelData);
      }
    }

    return true; // ノードを維持
  }

  /**
   * オーディオサンプルを解析してメインスレッドに送信する。
   *
   * 送信するデータ:
   * - rms:      スムージング済みRMS値（0.0〜1.0）
   * - peak:     ピークホールド値（0.0〜1.0、緩やかに減衰）
   * - waveform: ダウンサンプリングした波形データ（64点）
   *
   * @param {Float32Array} samples - 解析する128サンプルのデータ
   */
  _analyzeAndReport(samples) {
    let sum  = 0; // 二乗和（RMS計算用）
    let peak = 0; // 瞬間ピーク値

    // RMSと瞬間ピークを1パスで計算（効率化）
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i]);
      sum += samples[i] * samples[i]; // 二乗和
      if (abs > peak) peak = abs;     // 最大絶対値
    }

    // === RMS計算（スムージング付き） ===
    // 平滑化: smoothRMS = 0.7 * 前回値 + 0.3 * 今回値
    // これにより急激な変動が滑らかになりメーターが安定する
    const rms = Math.sqrt(sum / samples.length);
    this.smoothRMS = this.smoothRMS * 0.7 + rms * 0.3;

    // === ピークホールド処理 ===
    // 上昇は瞬時（クリッピングを確実に検知）
    // 下降は緩やか（0.995倍/呼び出し = 約秒間50%まで減衰）
    if (peak > this.peakHold) {
      this.peakHold = peak;    // 瞬時に更新
    } else {
      this.peakHold *= 0.995;  // 緩やかに減衰
    }

    // === 波形データ生成（ダウンサンプリング: 128→64点）===
    // ビジュアライザーで使用する波形データ。
    // 128サンプルを64点に間引くことでデータ転送量を削減。
    const waveform = new Float32Array(64);
    const step = samples.length / 64;
    for (let i = 0; i < 64; i++) {
      waveform[i] = samples[Math.floor(i * step)];
    }

    // メインスレッドにデータを送信（MessageChannel経由）
    // ※ waveform は Transferable として転送可能だが、
    //   小さいサイズなのでコピー転送で十分
    this.port.postMessage({
      type:     'levels',
      rms:      this.smoothRMS,
      peak:     this.peakHold,
      waveform: waveform,
    });
  }
}

// AudioWorkletにこのプロセッサを登録する。
// 登録名 'audio-level-processor' は AudioWorkletNode 生成時に使用:
//   new AudioWorkletNode(ctx, 'audio-level-processor')
registerProcessor('audio-level-processor', AudioLevelProcessor);
