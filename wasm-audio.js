/**
 * wasm-audio.js - WebAssembly オーディオ処理モジュール
 *
 * 【概要】
 * MP3プレイヤーのオーディオ解析（RMS・ピーク・スペクトラム）を担当する。
 * WebAssemblyバイナリをJavaScriptから直接構築してインライン化しており、
 * 外部の.wasmファイルを必要とせずオフライン動作・GitHub Pages配信が可能。
 *
 * 【アーキテクチャ】
 * +------------------+      +-------------------+
 * |  app.js          |      |  wasm-audio.js     |
 * |  AudioEngine     | ---> |  WasmAudioProcessor|
 * |  (再生・PCM管理)  |      |  (RMS/Peak/Spectrum)|
 * +------------------+      +-------------------+
 *                                    |
 *                           +--------v--------+
 *                           | Wasmバイナリ    |
 *                           | (手動バイト構築)|
 *                           | - process_rms   |
 *                           | - process_peak  |
 *                           | - apply_gain    |
 *                           | - get_buffer_ptr|
 *                           +----------------+
 *
 * 【DFT（スペクトラム解析）について】
 * Wasmバイナリ内にDFTを実装すると命令列が複雑すぎてデバッグ困難なため、
 * DFTはJavaScriptで実装し、Wasmはシンプルなベクトル演算（RMS・Peak・Gain）
 * のみを担当するハイブリッド設計とした。
 *
 * 【メモリレイアウト】
 * Wasmメモリ（1MB〜16MB）
 * ┌─────────────────────────────────────┐
 * │ 0x000000  入力サンプルバッファ       │ Float32配列
 * │           （JSから書き込み）         │
 * └─────────────────────────────────────┘
 */

// ============================================================
// WebAssembly バイナリビルダー（補助クラス）
//
// WebAssemblyバイナリフォーマット（.wasmファイル）はバイト列で構成される。
// このクラスはそのバイト列を JavaScript 側で組み立てるためのユーティリティ。
//
// 参考: https://webassembly.github.io/spec/core/binary/
// ============================================================
class WasmModuleBuilder {
  constructor() {
    /** @type {number[]} 構築中のバイト列 */
    this.bytes = [];
  }

  /**
   * LEB128エンコード（符号なし32bit整数）
   * WebAssemblyでは整数値をLEB128形式で可変長エンコードする。
   * 各バイトの最上位ビット（MSB）が1の場合は後続バイトがあることを示す。
   * 例: 624485 → 0xE5 0x8E 0x26
   * @param {number} value - エンコードする値（0以上）
   * @returns {number[]} LEB128エンコード済みバイト列
   */
  encodeU32(value) {
    const result = [];
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80; // 後続バイトがある場合は MSB を立てる
      result.push(byte);
    } while (value !== 0);
    return result;
  }

  /**
   * LEB128エンコード（符号付き32bit整数）
   * 負の数も扱えるサイン拡張版LEB128。
   * @param {number} value - エンコードする値
   * @returns {number[]} LEB128エンコード済みバイト列
   */
  encodeI32(value) {
    const result = [];
    let more = true;
    while (more) {
      let byte = value & 0x7f;
      value >>= 7;
      // 符号ビットが収まったら終了
      if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) {
        more = false;
      } else {
        byte |= 0x80;
      }
      result.push(byte);
    }
    return result;
  }

  /**
   * IEEE 754 単精度浮動小数点（32bit）エンコード
   * @param {number} value - エンコードする浮動小数点数
   * @returns {number[]} 4バイト列（リトルエンディアン）
   */
  encodeF32(value) {
    const buf = new ArrayBuffer(4);
    new Float32Array(buf)[0] = value;
    return [...new Uint8Array(buf)];
  }

  /**
   * Wasmセクションを追加する
   * Wasmバイナリはセクションの列で構成される。
   * 各セクションは「セクションID(1B) + データ長(LEB128) + データ」の形式。
   * @param {number} id - セクションID（例: 0x01=Type, 0x07=Export）
   * @param {number[]} content - セクションのデータ部分
   */
  addSection(id, content) {
    this.bytes.push(id);
    this.bytes.push(...this.encodeU32(content.length));
    this.bytes.push(...content);
  }

  /**
   * ベクタ（配列）をWasmバイナリ形式でエンコード
   * Wasmの「vector」型: 要素数（LEB128）+ 要素列
   * @param {number[][]} items - エンコードする要素の配列
   * @returns {number[]} エンコード済みバイト列
   */
  vec(items) {
    const flat = items.flat();
    return [...this.encodeU32(items.length), ...flat];
  }

  /**
   * 構築済みバイト列をUint8Arrayに変換して返す
   * @returns {Uint8Array}
   */
  build() {
    return new Uint8Array(this.bytes);
  }
}

/**
 * オーディオ処理Wasm モジュールのメタデータ（コメント用）
 *
 * エクスポートされる関数一覧:
 *   process_rms(ptr: i32, len: i32) -> f32
 *     - ptr: Wasmメモリ上のFloat32サンプル配列の先頭アドレス
 *     - len: サンプル数
 *     - 戻り値: RMS（Root Mean Square / 実効値）
 *
 *   process_peak(ptr: i32, len: i32) -> f32
 *     - ptr: サンプル配列のアドレス
 *     - len: サンプル数
 *     - 戻り値: 最大絶対値（ピークレベル）
 *
 *   apply_gain(ptr: i32, len: i32, gain: f32) -> void
 *     - サンプル配列にゲインを乗算（インプレース処理）
 *
 *   get_buffer_ptr() -> i32
 *     - 内部バッファの先頭アドレスを返す（オフセット0）
 *
 * ※ compute_spectrum はWasmバイナリ内に定義されているが、
 *    実際のスペクトラム計算はJavaScript側で行う（ハイブリッド設計）
 */

// ============================================================
// WasmAudioProcessor クラス
// オーディオ解析の高水準インターフェース
// ============================================================

/**
 * WebAssembly を使ったオーディオ処理クラス。
 *
 * 使い方:
 *   const proc = new WasmAudioProcessor();
 *   await proc.init();
 *   const rms  = proc.computeRMS(samples);
 *   const peak = proc.computePeak(samples);
 *   const spec = proc.computeSpectrum(samples, 64);
 */
class WasmAudioProcessor {
  constructor() {
    /** @type {WebAssembly.Instance|null} コンパイル済みWasmインスタンス */
    this.instance = null;
    /** @type {WebAssembly.Memory|null} Wasmが使用する共有メモリ */
    this.memory = null;
    /** @type {boolean} 初期化完了フラグ */
    this.ready = false;
    /** @type {number} FFT解析用バッファサイズ（サンプル数） */
    this.fftSize = 2048;
  }

  /**
   * Wasmモジュールを初期化する。
   * バイナリを手動構築し、コンパイル・インスタンス化まで行う。
   * ユーザー操作後（AudioContext.resume後）に呼び出すこと。
   * @returns {Promise<WasmAudioProcessor>} this（チェーン可能）
   */
  async init() {
    // Wasmバイナリをメモリ上に構築
    const wasmBinary = this._buildWasmBinary();

    // コンパイル（バイナリを検証してモジュールオブジェクトを作成）
    const module = await WebAssembly.compile(wasmBinary);

    // インスタンス化（数学関数を env としてインポート）
    this.instance = await WebAssembly.instantiate(module, {
      env: {
        // Wasmからは直接Math関数を呼べないため、JSからインポートして渡す
        sqrt: Math.sqrt,
        abs:  Math.abs,
        sin:  Math.sin,
        cos:  Math.cos,
        log:  Math.log,
      }
    });

    // エクスポートされたメモリオブジェクトを保持（サンプルの読み書きに使用）
    this.memory = this.instance.exports.memory;
    this.ready = true;
    return this;
  }

  /**
   * Wasmバイナリを手動で構築する。
   *
   * WebAssemblyバイナリフォーマットの構造:
   * ┌─────────────────────────────────────┐
   * │ マジックナンバー: \0asm (4B)         │
   * │ バージョン: 1 (4B)                   │
   * ├─────────────────────────────────────┤
   * │ Section 1: Type    (関数シグネチャ)  │
   * │ Section 2: Import  (JS関数のインポート)│
   * │ Section 3: Function(型インデックス)  │
   * │ Section 5: Memory  (メモリ宣言)      │
   * │ Section 7: Export  (外部公開)        │
   * │ Section 10: Code   (関数本体バイト列)│
   * └─────────────────────────────────────┘
   *
   * @returns {Uint8Array} コンパイル可能なWasmバイナリ
   */
  _buildWasmBinary() {
    const bytes = [];

    // ============================================================
    // ヘルパー関数群（LEB128エンコード等）
    // ============================================================

    /** 符号なしLEB128 */
    const u32 = (v) => {
      const r = [];
      do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; r.push(b); } while (v);
      return r;
    };
    /** 符号付きLEB128 */
    const i32 = (v) => {
      const r = [];
      let more = true;
      while (more) {
        let b = v & 0x7f; v >>= 7;
        if ((v === 0 && !(b & 0x40)) || (v === -1 && (b & 0x40))) more = false;
        else b |= 0x80;
        r.push(b);
      }
      return r;
    };
    /** IEEE 754 float32 → 4バイト列 */
    const f32 = (v) => {
      const buf = new ArrayBuffer(4);
      new Float32Array(buf)[0] = v;
      return [...new Uint8Array(buf)];
    };
    /** UTF-8文字列 → [長さ(LEB128), ...bytes] */
    const str = (s) => {
      const e = new TextEncoder().encode(s);
      return [...u32(e.length), ...e];
    };
    /** セクションをバイト列に追加 */
    const section = (id, content) => {
      bytes.push(id, ...u32(content.length), ...content);
    };

    // ============================================================
    // マジックナンバー + バージョン番号
    // すべてのwasmファイルはこの8バイトで始まる
    // ============================================================
    bytes.push(
      0x00, 0x61, 0x73, 0x6d, // "\0asm"
      0x01, 0x00, 0x00, 0x00  // version 1
    );

    // ============================================================
    // Section 1: Type Section
    // 関数の型（引数・戻り値の型）を定義する。
    // 関数本体はここで定義した型を参照（インデックスで指定）。
    //
    // Wasmの型エンコード:
    //   0x60 = functype
    //   0x7f = i32, 0x7e = i64, 0x7d = f32, 0x7c = f64
    //   0x00 = void（戻り値なし）
    // ============================================================
    const typeEntries = [
      // type0: (f64) -> f64
      //   数学関数インポート用（sqrt, abs, sin, cos, log）
      [0x60, 0x01, 0x7c, 0x01, 0x7c],

      // type1: (i32, i32) -> f32
      //   process_rms(ptr, len) / process_peak(ptr, len) 用
      [0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7d],

      // type2: (i32, i32, f32) -> void
      //   apply_gain(ptr, len, gain) 用
      [0x60, 0x03, 0x7f, 0x7f, 0x7d, 0x00],

      // type3: (i32, i32, i32, i32) -> void
      //   compute_spectrum(inputPtr, realPtr, magPtr, len) 用
      [0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x00],

      // type4: () -> i32
      //   get_buffer_ptr() 用（引数なし・i32を返す）
      [0x60, 0x00, 0x01, 0x7f],
    ];
    {
      const content = [typeEntries.length];
      typeEntries.forEach(t => content.push(...t));
      section(0x01, content);
    }

    // ============================================================
    // Section 2: Import Section
    // JavaScriptから数学関数をインポートする。
    // Wasmは直接Math.*を呼べないため、envオブジェクト経由で受け取る。
    //
    // インポートの形式: [モジュール名, 関数名, 種別(0x00=func), 型インデックス]
    // ============================================================
    const imports = [
      [...str('env'), ...str('sqrt'), 0x00, ...u32(0)], // func index 0: sqrt(f64)->f64
      [...str('env'), ...str('abs'),  0x00, ...u32(0)], // func index 1: abs(f64)->f64
      [...str('env'), ...str('sin'),  0x00, ...u32(0)], // func index 2: sin(f64)->f64
      [...str('env'), ...str('cos'),  0x00, ...u32(0)], // func index 3: cos(f64)->f64
      [...str('env'), ...str('log'),  0x00, ...u32(0)], // func index 4: log(f64)->f64
    ];
    {
      const content = [...u32(imports.length)];
      imports.forEach(imp => content.push(...imp));
      section(0x02, content);
    }

    // ============================================================
    // Section 3: Function Section
    // 各関数がどの型（Type Section の型インデックス）を使うかを宣言する。
    // インポートした関数（func 0〜4）は含まず、定義関数のみリストする。
    //
    // func 5: process_rms      → type1 (i32,i32)->f32
    // func 6: process_peak     → type1 (i32,i32)->f32
    // func 7: apply_gain       → type2 (i32,i32,f32)->void
    // func 8: compute_spectrum → type3 (i32,i32,i32,i32)->void
    // func 9: get_buffer_ptr   → type4 ()->i32
    // ============================================================
    section(0x03, [0x05, 0x01, 0x01, 0x02, 0x03, 0x04]);

    // ============================================================
    // Section 5: Memory Section
    // Wasmが使用するリニアメモリを宣言する。
    // 初期ページ数: 16ページ（16×64KB = 1MB）
    // 最大ページ数: 256ページ（256×64KB = 16MB）
    // このメモリはJSとWasm間でゼロコピー共有される。
    // ============================================================
    section(0x05, [
      0x01,           // memory count = 1
      0x01,           // limits type = min/max
      ...u32(16),     // min: 16 pages (1MB)
      ...u32(256),    // max: 256 pages (16MB)
    ]);

    // ============================================================
    // Section 7: Export Section
    // JavaScriptから呼び出せるように関数・メモリを公開する。
    // エクスポート形式: [名前(str), 種別(0x00=func/0x02=mem), インデックス]
    // ============================================================
    const exps = [
      [...str('memory'),           0x02, ...u32(0)], // Wasmメモリを公開
      [...str('process_rms'),      0x00, ...u32(5)], // func 5
      [...str('process_peak'),     0x00, ...u32(6)], // func 6
      [...str('apply_gain'),       0x00, ...u32(7)], // func 7
      [...str('compute_spectrum'), 0x00, ...u32(8)], // func 8
      [...str('get_buffer_ptr'),   0x00, ...u32(9)], // func 9
    ];
    {
      const content = [...u32(exps.length)];
      exps.forEach(e => content.push(...e));
      section(0x07, content);
    }

    // ============================================================
    // Section 10: Code Section
    // 各関数の命令列（バイトコード）を定義する。
    //
    // 関数本体の形式:
    //   [本体バイト長(LEB128)]
    //   [ローカル変数定義: count, (n, type)...]
    //   [Wasm命令列...]
    //   [0x0b] (end)
    //
    // 主要なWasm命令（オペコード）:
    //   0x20 local.get  / 0x21 local.set
    //   0x41 i32.const  / 0x44 f64.const
    //   0x6a i32.add    / 0x6c i32.mul
    //   0x92 f32.add    / 0x94 f32.mul
    //   0x2a f32.load   / 0x38 f32.store
    //   0x8b f32.abs    / 0xb6 f32.demote_f64
    //   0xbb f64.promote_f32 / 0xb8 f64.convert_i32_u
    //   0x10 call       / 0x0c br  / 0x0d br_if
    //   0x02 block      / 0x03 loop / 0x04 if
    //   0x0b end
    // ============================================================
    const funcBodies = [];

    // ----------------------------------------------------------
    // func 5: process_rms(ptr: i32, len: i32) -> f32
    // ----------------------------------------------------------
    // アルゴリズム:
    //   sum = 0
    //   for i in 0..len:
    //     val = memory[ptr + i*4]  // float32ロード
    //     sum += val * val
    //   return sqrt(sum / len)
    //
    // ローカル変数:
    //   param0 = ptr (i32)   ← 引数
    //   param1 = len (i32)   ← 引数
    //   local2 = sum (f32)   ← 二乗和の累計
    //   local3 = val (f32)   ← 現在のサンプル値
    //   local4 = i   (i32)   ← ループカウンタ
    // ----------------------------------------------------------
    {
      const body = [
        // ローカル変数宣言: 3種類 (sum:f32, val:f32, i:i32)
        0x03,
        0x01, 0x7d, // 1 x f32 → local2 (sum)
        0x01, 0x7d, // 1 x f32 → local3 (val)
        0x01, 0x7f, // 1 x i32 → local4 (i)

        // block $break（ループを抜けるためのラベル）
        0x02, 0x40,
          // loop $continue
          0x03, 0x40,
            // if (i >= len) break → br_if $break
            0x20, 0x04,  // local.get i
            0x20, 0x01,  // local.get len
            0x4e,        // i32.ge_u（符号なし比較）
            0x0d, 0x01,  // br_if $break

            // val = f32.load(memory[ptr + i * 4])
            0x20, 0x00,  // local.get ptr
            0x20, 0x04,  // local.get i
            0x41, 0x04,  // i32.const 4（float32は4バイト）
            0x6c,        // i32.mul
            0x6a,        // i32.add（ptr + i*4）
            0x2a, 0x02, 0x00, // f32.load (align=2, offset=0)
            0x21, 0x03,  // local.set val

            // sum += val * val（二乗を累積）
            0x20, 0x02,  // local.get sum
            0x20, 0x03,  // local.get val
            0x20, 0x03,  // local.get val
            0x94,        // f32.mul（val*val）
            0x92,        // f32.add（sum + val*val）
            0x21, 0x02,  // local.set sum

            // i++
            0x20, 0x04,  // local.get i
            0x41, 0x01,  // i32.const 1
            0x6a,        // i32.add
            0x21, 0x04,  // local.set i

            // ループ先頭に戻る
            0x0c, 0x00,  // br $continue
          0x0b,           // end loop
        0x0b,             // end block

        // return sqrt(sum / len)
        // f32→f64に昇格してから除算（精度確保）
        0x20, 0x02,  // local.get sum
        0xbb,        // f64.promote_f32
        0x20, 0x01,  // local.get len
        0xb8,        // f64.convert_i32_u
        0xa3,        // f64.div
        0x10, 0x00,  // call sqrt（import 0）
        0xb6,        // f32.demote_f64（戻り値はf32）
        0x0b,        // end
      ];
      funcBodies.push([...u32(body.length), ...body]);
    }

    // ----------------------------------------------------------
    // func 6: process_peak(ptr: i32, len: i32) -> f32
    // ----------------------------------------------------------
    // アルゴリズム:
    //   peak = 0
    //   for i in 0..len:
    //     val = abs(memory[ptr + i*4])
    //     if val > peak: peak = val
    //   return peak
    //
    // ローカル変数: same layout as process_rms
    //   local2 = peak (f32), local3 = val (f32), local4 = i (i32)
    // ----------------------------------------------------------
    {
      const body = [
        0x03, 0x01, 0x7d, 0x01, 0x7d, 0x01, 0x7f, // locals宣言

        // block / loop
        0x02, 0x40,
          0x03, 0x40,
            // if i >= len: break
            0x20, 0x04, 0x20, 0x01, 0x4e, 0x0d, 0x01,

            // val = abs(f32.load(ptr + i*4))
            0x20, 0x00, 0x20, 0x04, 0x41, 0x04, 0x6c, 0x6a,
            0x2a, 0x02, 0x00, // f32.load
            0x8b,             // f32.abs（絶対値）
            0x21, 0x03,       // local.set val

            // if val > peak: peak = val
            0x20, 0x03,  // local.get val
            0x20, 0x02,  // local.get peak
            0x60,        // f32.gt（val > peak ?）
            0x04, 0x40,  // if true:
              0x20, 0x03, 0x21, 0x02, // peak = val
            0x0b,        // end if

            // i++
            0x20, 0x04, 0x41, 0x01, 0x6a, 0x21, 0x04,
            0x0c, 0x00,  // br $continue
          0x0b,           // end loop
        0x0b,             // end block

        // return peak
        0x20, 0x02,
        0x0b,
      ];
      funcBodies.push([...u32(body.length), ...body]);
    }

    // ----------------------------------------------------------
    // func 7: apply_gain(ptr: i32, len: i32, gain: f32) -> void
    // ----------------------------------------------------------
    // アルゴリズム:
    //   for i in 0..len:
    //     memory[ptr + i*4] *= gain  // インプレース乗算
    //
    // ローカル変数:
    //   param0 = ptr (i32), param1 = len (i32), param2 = gain (f32)
    //   local3 = i   (i32) ← ループカウンタ
    // ----------------------------------------------------------
    {
      const body = [
        0x01, 0x01, 0x7f, // 1 local: i (i32)

        0x02, 0x40,
          0x03, 0x40,
            // if i >= len: break
            0x20, 0x03, 0x20, 0x01, 0x4e, 0x0d, 0x01,

            // addr = ptr + i * 4
            0x20, 0x00, 0x20, 0x03, 0x41, 0x04, 0x6c, 0x6a,

            // f32.store(addr, f32.load(addr) * gain)
            // スタック: [addr] 再計算してからストア
            0x20, 0x00, 0x20, 0x03, 0x41, 0x04, 0x6c, 0x6a,
            0x2a, 0x02, 0x00, // f32.load（値を取得）
            0x20, 0x02,       // local.get gain
            0x94,             // f32.mul（×gain）
            0x38, 0x02, 0x00, // f32.store（書き戻し）

            // i++
            0x20, 0x03, 0x41, 0x01, 0x6a, 0x21, 0x03,
            0x0c, 0x00,
          0x0b,
        0x0b,
        0x0b, // end（void関数）
      ];
      funcBodies.push([...u32(body.length), ...body]);
    }

    // ----------------------------------------------------------
    // func 8: compute_spectrum(inputPtr, realPtr, magPtr, len) -> void
    // ----------------------------------------------------------
    // 簡易DFT（離散フーリエ変換）の実装。
    // X[k] = Σ_n x[n] * e^(-j*2π*k*n/N)
    // magnitude[k] = sqrt(real[k]^2 + imag[k]^2) / N
    //
    // ※ 実際のアプリではJSのcomputeSpectrum()を使用。
    //    このWasm実装は将来的な高速化用として保持している。
    //
    // ローカル変数:
    //   param0 = inputPtr (i32)
    //   param1 = realPtr  (i32)  ← 現在未使用
    //   param2 = magPtr   (i32)  ← 出力先
    //   param3 = len      (i32)
    //   local4 = k   (i32)  ← 外側ループ（周波数ビン）
    //   local5 = n   (i32)  ← 内側ループ（サンプル）
    //   local6 = real(f64)  ← DFTの実部
    //   local7 = imag(f64)  ← DFTの虚部
    //   local8 = angle(f64) ← 回転角度 -2π*k*n/N
    //   local9 = val (f64)  ← 現在のサンプル値
    //   local10= mag (f64)  ← 計算済みマグニチュード
    // ----------------------------------------------------------
    {
      const body = [
        0x07,                // 7つのローカル変数
        0x01, 0x7f,          // k   (i32) local4
        0x01, 0x7f,          // n   (i32) local5
        0x01, 0x7c,          // real(f64) local6
        0x01, 0x7c,          // imag(f64) local7
        0x01, 0x7c,          // angle(f64)local8
        0x01, 0x7c,          // val (f64) local9
        0x01, 0x7c,          // mag (f64) local10

        // === 外側ループ: k = 0 .. len/2 ===
        0x02, 0x40,           // block $break_k
          0x03, 0x40,         // loop $loop_k
            // if k >= len/2: break
            0x20, 0x04,       // local.get k
            0x20, 0x03,       // local.get len
            0x41, 0x01, 0x76, // i32.const 1; i32.shr_u (len >> 1 = len/2)
            0x4e,             // i32.ge_u
            0x0d, 0x01,       // br_if $break_k

            // real = 0; imag = 0（f64の0定数: 8バイト）
            0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x21, 0x06,       // local.set real
            0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x21, 0x07,       // local.set imag

            // n = 0
            0x41, 0x00, 0x21, 0x05,

            // === 内側ループ: n = 0 .. len ===
            0x02, 0x40,       // block $break_n
              0x03, 0x40,     // loop $loop_n
                // if n >= len: break
                0x20, 0x05, 0x20, 0x03, 0x4e, 0x0d, 0x01,

                // angle = -2π * k * n / len
                // f64定数 -2π = -6.283185307...
                0x44, 0x18, 0x2d, 0x44, 0x54, 0xfb, 0x21, 0x19, 0xc0,
                0x20, 0x04, 0xb8,  // f64(k)
                0xa2,              // f64.mul（-2π*k）
                0x20, 0x05, 0xb8,  // f64(n)
                0xa2,              // f64.mul（-2π*k*n）
                0x20, 0x03, 0xb8,  // f64(len)
                0xa3,              // f64.div（/len）
                0x21, 0x08,        // local.set angle

                // val = f64(f32.load(inputPtr + n*4))
                0x20, 0x00, 0x20, 0x05, 0x41, 0x04, 0x6c, 0x6a,
                0x2a, 0x02, 0x00,  // f32.load
                0xbb,              // f64.promote_f32
                0x21, 0x09,        // local.set val

                // real += val * cos(angle)
                0x20, 0x06,        // local.get real
                0x20, 0x09,        // local.get val
                0x20, 0x08,        // local.get angle
                0x10, 0x04,        // call cos（import 3）
                0xa2,              // f64.mul
                0xa0,              // f64.add
                0x21, 0x06,        // local.set real

                // imag += val * sin(angle)
                0x20, 0x07,
                0x20, 0x09,
                0x20, 0x08,
                0x10, 0x02,        // call sin（import 2）
                0xa2,
                0xa0,
                0x21, 0x07,        // local.set imag

                // n++
                0x20, 0x05, 0x41, 0x01, 0x6a, 0x21, 0x05,
                0x0c, 0x00,        // br $loop_n
              0x0b,                // end loop_n
            0x0b,                  // end block_n

            // mag = sqrt(real² + imag²)
            0x20, 0x06, 0x20, 0x06, 0xa2,  // real*real
            0x20, 0x07, 0x20, 0x07, 0xa2,  // imag*imag
            0xa0,                          // f64.add
            0x10, 0x00,                    // call sqrt（import 0）
            0x21, 0x0a,                    // local.set mag

            // f32.store(magPtr + k*4, f32(mag / len))
            0x20, 0x02,   // local.get magPtr
            0x20, 0x04,   // local.get k
            0x41, 0x04,
            0x6c,
            0x6a,
            0x20, 0x0a,   // local.get mag
            0x20, 0x03, 0xb8, // f64(len)
            0xa3,         // f64.div
            0xb6,         // f32.demote_f64
            0x38, 0x02, 0x00, // f32.store

            // k++
            0x20, 0x04, 0x41, 0x01, 0x6a, 0x21, 0x04,
            0x0c, 0x00,  // br $loop_k
          0x0b,           // end loop_k
        0x0b,             // end block_k
        0x0b,             // end（void）
      ];
      funcBodies.push([...u32(body.length), ...body]);
    }

    // ----------------------------------------------------------
    // func 9: get_buffer_ptr() -> i32
    // ----------------------------------------------------------
    // Wasmメモリ上のサンプルバッファ先頭アドレスを返す。
    // JSからサンプルを書き込む際に使用（現在はオフセット0固定）。
    // ----------------------------------------------------------
    {
      const body = [
        0x00,        // ローカル変数なし
        0x41, 0x00,  // i32.const 0（バッファ先頭アドレス）
        0x0b,        // end
      ];
      funcBodies.push([...u32(body.length), ...body]);
    }

    // Code Section (0x0a) にすべての関数本体を追加
    {
      const content = [...u32(funcBodies.length)];
      funcBodies.forEach(fb => content.push(...fb));
      section(0x0a, content);
    }

    return new Uint8Array(bytes);
  }

  // ============================================================
  // メモリ I/O ヘルパー
  // JSのFloat32ArrayとWasmメモリ間でデータをやり取りする
  // ============================================================

  /**
   * Float32配列をWasmの共有メモリに書き込む。
   * Wasm関数を呼び出す前にサンプルデータを転送するために使用。
   * @param {Float32Array} data - 書き込むサンプルデータ
   * @param {number} offset - 書き込み先のバイトオフセット（デフォルト: 0）
   */
  writeToMemory(data, offset = 0) {
    // Wasmメモリに対してFloat32ArrayのビューをオーバーラップさせてコピーするだけでOK
    // （ゼロコピーではなく memcpy 相当）
    const memView = new Float32Array(this.memory.buffer, offset, data.length);
    memView.set(data);
  }

  /**
   * Wasmメモリから Float32配列を読み出す。
   * @param {number} offset - 読み出し元のバイトオフセット
   * @param {number} length - 読み出す要素数（float32の個数）
   * @returns {Float32Array} 読み出したデータ
   */
  readFromMemory(offset, length) {
    return new Float32Array(this.memory.buffer, offset, length);
  }

  // ============================================================
  // 公開API：オーディオ解析メソッド
  // ============================================================

  /**
   * RMS（Root Mean Square / 実効値）を計算する。
   * 音量の「平均的な大きさ」を表し、視覚的なレベルメーター表示に使用。
   * Wasmのprocess_rms関数を呼び出す（JavaScriptより高速）。
   *
   * @param {Float32Array} samples - 解析するPCMサンプル配列（-1.0〜1.0）
   * @returns {number} RMS値（0.0〜1.0）
   */
  computeRMS(samples) {
    if (!this.ready) return 0;
    const ptr = 0; // バッファ先頭（オフセット0）に書き込む
    this.writeToMemory(samples, ptr);
    return this.instance.exports.process_rms(ptr, samples.length);
  }

  /**
   * ピークレベル（瞬間最大値）を計算する。
   * サンプル内の絶対値最大を返す。クリッピング検出などに使用。
   * Wasmのprocess_peak関数を呼び出す（JavaScriptより高速）。
   *
   * @param {Float32Array} samples - 解析するPCMサンプル配列
   * @returns {number} ピーク値（0.0〜1.0）
   */
  computePeak(samples) {
    if (!this.ready) return 0;
    const ptr = 0;
    this.writeToMemory(samples, ptr);
    return this.instance.exports.process_peak(ptr, samples.length);
  }

  /**
   * ゲインをサンプル配列に適用する（インプレース処理）。
   * Wasmのapply_gain関数で全サンプルを一括乗算。
   *
   * @param {Float32Array} samples - 入力サンプル配列
   * @param {number} gain - 倍率（1.0 = 変化なし、0.5 = -6dB、2.0 = +6dB）
   * @returns {Float32Array} ゲイン適用済みのサンプル（コピー）
   */
  applyGain(samples, gain) {
    if (!this.ready) return samples;
    const ptr = 0;
    this.writeToMemory(samples, ptr);
    this.instance.exports.apply_gain(ptr, samples.length, gain);
    return this.readFromMemory(ptr, samples.length).slice(); // コピーを返す
  }

  /**
   * スペクトラム解析を行い、周波数成分のマグニチュードを返す。
   *
   * 【実装方針（ハイブリッド設計）】
   * WasmバイナリにDFTを実装したが、デバッグの複雑さと
   * 実用的な速度（bin数64程度なら十分）を考慮し、
   * DFT本体はJavaScriptで実装。WasmはRMS正規化などの補助に留める。
   *
   * 【DFTアルゴリズム】
   * X[k] = Σ_{n=0}^{N-1} x[n] * (cos(2πkn/N) - j*sin(2πkn/N))
   * magnitude[k] = sqrt(Re²+Im²) / N → 正規化して0〜1に収める
   *
   * @param {Float32Array} samples - 入力PCMサンプル（2048サンプル推奨）
   * @param {number} bins - 出力する周波数ビン数（デフォルト64）
   * @returns {Float32Array} 各ビンのマグニチュード（0.0〜1.0に正規化）
   */
  computeSpectrum(samples, bins = 64) {
    if (!samples || samples.length === 0) return new Float32Array(bins);

    // ダウンサンプリング（DFTの計算量をbins×2に制限）
    const N = bins * 2;
    const buf = new Float32Array(N);
    const step = samples.length / N;
    for (let i = 0; i < N; i++) {
      buf[i] = samples[Math.floor(i * step)] || 0;
    }

    // === DFT計算（JavaScript実装）===
    const magnitudes = new Float32Array(bins);
    const TWO_PI = 2 * Math.PI;
    let maxMag = 0;

    for (let k = 0; k < bins; k++) {
      let real = 0; // DFTの実部
      let imag = 0; // DFTの虚部
      for (let n = 0; n < N; n++) {
        const angle = (TWO_PI * k * n) / N;
        real += buf[n] * Math.cos(angle);
        imag -= buf[n] * Math.sin(angle); // 共役（負の虚部）
      }
      // マグニチュード = sqrt(real² + imag²) / N
      const mag = Math.sqrt(real * real + imag * imag) / N;
      magnitudes[k] = mag;
      if (mag > maxMag) maxMag = mag;
    }

    // 最大値で正規化（0.0〜1.0に収める）
    if (maxMag > 0) {
      for (let k = 0; k < bins; k++) {
        magnitudes[k] /= maxMag;
      }
    }

    return magnitudes;
  }
}

// グローバルスコープに公開（app.js から参照できるようにする）
window.WasmAudioProcessor = WasmAudioProcessor;
