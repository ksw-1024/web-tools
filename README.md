# AVIF Converter

画像ファイルをAVIF形式に変換するGUIアプリケーション

![Python](https://img.shields.io/badge/Python-3.8%2B-blue)
![License](https://img.shields.io/badge/License-MIT-green)

## 特徴

✨ **シンプルで洗練されたUI** - customtkinterによるモダンなデザイン  
🖱️ **ドラッグ&ドロップ対応** - 複数ファイルの一括変換が簡単  
⚡ **非同期処理** - 変換中もUIが固まらない  
📊 **リアルタイムプログレス表示** - 進行状況が一目瞭然  
🎨 **多様な画像形式をサポート** - JPG, PNG, BMP, GIF, TIFF, WebPに対応  

## 必要要件

- Python 3.8以上
- Windows / macOS / Linux

## インストール

### 1. リポジトリのクローン

```bash
git clone <repository-url>
cd avif-converter
```

### 2. 仮想環境の作成と有効化

**Windows:**
```powershell
python -m venv .venv
.\.venv\Scripts\activate
```

**macOS/Linux:**
```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 3. 依存パッケージのインストール

```bash
pip install -r requirements.txt
```

## 使い方

### アプリケーションの起動

```bash
python main.py
```

### 変換手順

1. **画像を選択**
   - ドラッグ&ドロップエリアに画像ファイルをドロップ
   - または「画像ファイルを選択」ボタンから選択

2. **保存先を指定**
   - 「保存先フォルダを選択」ボタンをクリック
   - 変換後のAVIFファイルを保存するフォルダを選択

3. **変換開始**
   - 「AVIF形式に変換」ボタンをクリック
   - プログレスバーで進行状況を確認

## 対応画像形式

- JPEG (`.jpg`, `.jpeg`)
- PNG (`.png`)
- BMP (`.bmp`)
- GIF (`.gif`)
- TIFF (`.tiff`, `.tif`)
- WebP (`.webp`)

## 技術スタック

- **GUI**: customtkinter 5.2.2
- **画像処理**: Pillow 10.4.0+
- **AVIF変換**: pillow-avif-plugin 1.4.3+
- **ドラッグ&ドロップ**: tkinterdnd2 0.3.0
- **非同期処理**: threading (標準ライブラリ)

## プロジェクト構造

```
avif-converter/
│
├── main.py              # メインアプリケーション
├── requirements.txt     # 依存パッケージ
├── README.md           # このファイル
├── TODO.md             # 開発ToDoリスト
├── .gitignore          # Git除外設定
└── .venv/              # 仮想環境（除外）
```

## 設定

デフォルトの変換品質は `quality=85` に設定されています。  
変換品質を変更したい場合は、`main.py`の以下の行を編集してください：

```python
img.save(output_path, 'AVIF', quality=85)  # 0-100の値に変更可能
```

## 今後の改善予定

- [ ] 変換のキャンセル機能
- [ ] 品質設定のUI追加
- [ ] バッチ処理の最適化
- [ ] エラーログの出力機能
- [ ] ダークモード/ライトモードの切り替え

## トラブルシューティング

### アプリが起動しない

- Python 3.8以上がインストールされているか確認
- 仮想環境が有効化されているか確認
- 依存パッケージが正しくインストールされているか確認

### 変換が失敗する

- 画像ファイルが破損していないか確認
- 保存先フォルダへの書き込み権限があるか確認
- ディスクの空き容量が十分にあるか確認

## ライセンス

MIT License

## 貢献

プルリクエストを歓迎します！  
大きな変更の場合は、まずissueを開いて変更内容を議論してください。

## 作者

開発者: [Your Name]

---

**注意**: AVIF形式は比較的新しい形式です。一部の古いソフトウェアでは表示できない場合があります。
