# PWA MP3 Player

WebAssembly を活用した高性能 PWA（Progressive Web App）MP3プレイヤー。  
GitHub Pages などの静的ホスティングで配信でき、iPhone・Android のホーム画面にインストールしてオフラインで再生できます。

---

## 主な機能

| 機能 | 説明 |
|---|---|
| **オフライン再生** | Service Worker によるキャッシュで、ネットワークなしでも動作 |
| **ロック画面再生** | `<audio>` 要素による直接再生で iOS/Android ロック画面でも継続 |
| **ロック画面コントロール** | Media Session API で再生・一時停止・前後スキップを操作可能 |
| **ライブラリ管理** | IndexedDB に MP3 を永続保存。アプリを閉じても曲が残る |
| **アートワーク表示** | ID3v2 タグ（APIC フレーム）からアルバムアートを自動抽出・表示 |
| **スペクトラム表示** | DFT（離散フーリエ変換）による周波数スペクトラムをビジュアライザーで表示 |
| **RMS / Peak メーター** | WebAssembly で高速計算したレベルメーターをリアルタイム表示 |
| **プレイリスト並び替え** | ドラッグ＆ドロップ（PC）/ 長押しドラッグ（iOS）で曲順を変更 |
| **再生無効化フラグ** | 特定の曲を一時的に再生リストから除外できるトグル機能 |
| **シャッフル / リピート** | ランダム再生と1曲リピートに対応 |
| **PWA インストール** | ホーム画面に追加してネイティブアプリのように使用可能 |

---

## デモ・使い方

### インストール方法（iPhone / iOS）

1. Safari でこのアプリのURLを開く
2. 画面下部の「共有」ボタン（□↑）をタップ
3. 「ホーム画面に追加」を選択
4. 「追加」をタップ

> **Note**: iOS では Safari からのみ PWA のインストールが可能です。Chrome などの他のブラウザからはインストールできません。

### インストール方法（Android）

1. Chrome でURLを開く
2. 画面下部に表示される「ホーム画面に追加」バナーをタップ
3. または Chrome メニュー → 「アプリをインストール」

### MP3 ファイルの追加

- **「+ ファイルを追加」ボタン**: iPhone の「ファイル」アプリや写真アプリから MP3 を選択
- **ドラッグ＆ドロップ**: PC 上でブラウザウィンドウに MP3 ファイルをドロップ
- **複数ファイル対応**: 一度に複数の MP3 を追加可能

---

## 技術仕様

### アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│ ブラウザ                                                      │
│                                                               │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────────┐  │
│  │  PlayerUI   │    │ AudioEngine  │    │  MusicStore    │  │
│  │ (UI制御)    │───>│ (再生・解析) │    │ (IndexedDB)    │  │
│  └─────────────┘    └──────────────┘    └────────────────┘  │
│         │                  │                    │            │
│         │           ┌──────┴──────┐             │            │
│         │           │  <audio>要素│             │            │
│         │           │  (直接再生) │             │            │
│         │           └─────────────┘             │            │
│         │                  │                    │            │
│         │           ┌──────┴──────┐    ┌────────┴───────┐   │
│         │           │WasmProcessor│    │  MP3 データ    │   │
│         │           │(RMS/Peak)   │    │  (永続保存)    │   │
│         │           └─────────────┘    └────────────────┘   │
│         │                                                     │
│  ┌──────┴──────┐    ┌──────────────┐                        │
│  │ Service     │    │ Media Session│                        │
│  │ Worker      │    │ API          │                        │
│  │(オフライン) │    │(ロック画面)  │                        │
│  └─────────────┘    └──────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

### ファイル構成

```
PWAMp3Player/
├── index.html          # メインHTML（UI構造・コメント詳細）
├── style.css           # ダークテーマのスタイルシート
├── app.js              # メインアプリケーションロジック
│                       #   - MusicStore: IndexedDB管理
│                       #   - AudioEngine: 再生・解析エンジン
│                       #   - PlayerUI: UIコントローラー
│                       #   - extractArtwork: ID3v2タグ解析
├── wasm-audio.js       # WebAssemblyオーディオ処理モジュール
│                       #   - WasmAudioProcessor クラス
│                       #   - RMS/Peak/Gainの高速計算
│                       #   - DFTスペクトラム解析（JSハイブリッド）
├── audio-processor.js  # AudioWorkletプロセッサ（将来拡張用）
├── manifest.json       # PWAマニフェスト
├── sw.js               # Service Worker（Cache First戦略）
└── icons/
    ├── icon-192.png    # アプリアイコン（192×192px）
    └── icon-512.png    # アプリアイコン（512×512px）
```

### 使用技術

| 技術 | 用途 |
|---|---|
| **WebAssembly** | RMS・Peak レベルの高速ベクトル演算 |
| **IndexedDB** | MP3 ファイルの永続ストレージ（オフライン保存） |
| **Web Audio API** | デコード専用 AudioContext（PCM バッファ取得） |
| **HTMLAudioElement** | 実際の音声出力（iOS バックグラウンド再生対応） |
| **Media Session API** | ロック画面・通知センターのコントロール表示 |
| **Service Worker** | オフラインキャッシュ（Cache First 戦略） |
| **HTML5 Canvas** | スペクトラムビジュアライザー描画 |
| **HTML5 Drag and Drop** | プレイリスト並び替え（PC） |
| **Touch Events** | プレイリスト並び替え（iOS タッチ） |

---

## 設計上の工夫

### iOS バックグラウンド再生

iOS Safari では `AudioContext` を音声経路に挟むとロック画面で音が止まる問題があります。  
本アプリでは以下の設計でこれを解決しています：

```
【問題のある設計】
AudioBufferSourceNode → AudioContext → スピーカー
                         ↑ ロック画面でサスペンドされる

【本アプリの設計】
<audio> 要素 → スピーカー   ← 直接再生（ロック画面でも継続）
     ↓
decodeAudioData (別途PCMデコード)
     ↓
PCMバッファ → WasmProcessor → ビジュアライザー・レベルメーター
```

音声の出力は `<audio>` 要素が担当し、解析用の PCM データは別途 `decodeAudioData()` でデコードします。`AudioContext` は解析専用のため音声経路に介在せず、バックグラウンド再生に影響しません。

### WebAssembly のインライン生成

通常 WebAssembly は外部の `.wasm` ファイルを読み込みますが、  
本アプリでは JavaScript コードから直接バイナリを構築します：

```javascript
// WAT（WebAssemblyテキスト形式）でのRMS計算イメージ
// (func $process_rms (param $ptr i32) (param $len i32) (result f32)
//   ...ループでサンプルを読み込み、二乗和→sqrt...
// )

// → JSコードがこのバイナリを直接構築して WebAssembly.compile() に渡す
const binary = this._buildWasmBinary(); // Uint8Array
const module = await WebAssembly.compile(binary);
```

これにより外部ファイルなしで単一の JS ファイルに完結し、GitHub Pages への配信が容易になります。

### ID3v2 アートワーク抽出

MP3 ファイルには ID3v2 形式のメタデータが埋め込まれており、  
APIC フレームにアルバムアート画像が含まれます：

```
MP3ファイル
└── ID3v2 ヘッダー (10バイト)
    ├── TIT2 フレーム: タイトル
    ├── TPE1 フレーム: アーティスト
    ├── APIC フレーム: アルバムアート ← ここを解析
    │   ├── エンコーディング (1B)
    │   ├── MIME タイプ (null終端)
    │   ├── 画像タイプ (1B)
    │   ├── 説明文 (null終端)
    │   └── 画像データ (JPEG/PNG)
    └── ...
```

本アプリは ID3v2.2 / v2.3 / v2.4 すべてに対応し、  
UTF-16 エンコーディングのディスクリプションにも対応しています。

---

## ブラウザ対応状況

| ブラウザ | 動作確認 | 備考 |
|---|---|---|
| iOS Safari 16+ | ✅ | ロック画面再生・PWA インストール対応 |
| Android Chrome | ✅ | PWA インストールバナー表示 |
| Chrome (PC) | ✅ | ドラッグ＆ドロップ対応 |
| Firefox | ✅ | AudioWorklet 対応 |
| Edge | ✅ | Chrome と同等 |
| iOS Chrome / Firefox | ⚠️ | PWA インストール不可（Safari 限定） |

---

## ローカル開発

静的ファイルなので任意の HTTP サーバーで起動できます。

```bash
# Python を使う場合
python -m http.server 8080

# Node.js (npx) を使う場合
npx serve .

# VS Code の Live Server 拡張機能でも可
```

ブラウザで `http://localhost:8080` を開いてください。

> **Note**: `file://` プロトコルでは Service Worker・IndexedDB が正常動作しないため、必ず HTTP サーバー経由でアクセスしてください。

---

## ライセンス

MIT License
