# NAI Blue

<p align="center">
  <img src="public/nai-blue.png" alt="NAI Blue ロゴ" width="128" height="128">
</p>

<p align="center">
  NovelAIの画像生成ワークフローを作成・整理・実行するデスクトップ／Androidワークスペース
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.ja.md">日本語</a>
</p>

> NAI Blueは独立したコミュニティクライアントであり、NovelAIとの提携または公式な承認を受けた製品ではありません。

## インストール

[GitHub Releases](https://github.com/bluehair-blue/NAI-Blue/releases/latest)から環境に合うファイルをダウンロードしてください。

- Windows: 通常は`x64-setup.exe`を使用します。管理環境向けのMSIも提供しています。
- macOS: Apple Siliconは`aarch64`、Intel Macは`x64`を選びます。このリポジトリから取得したことを確認した上で「壊れている」と表示される場合は、ターミナルで`xattr -cr "/Applications/NAI Blue.app"`を実行してください。
- Android: 署名済みuniversal APKをインストールします。APKを開いたアプリに「不明なアプリのインストール」権限が必要な場合があります。

## 初回設定

1. NAI Blueを起動し、最初の設定は**Guided**画面で進めます。
2. アカウント／APIステップでNovelAIアカウントを接続し、トークンを検証します。
3. **1枚生成**または**複数画像**を選びます。
4. メイン、ネガティブ、キャラクタープロンプトを編集します。キャラクター位置の初期値は中央の`0.5, 0.5`で、タスクごとに変更できます。
5. 出力フォルダーとメタデータ方針を選び、設定を確認してキューへ追加します。
6. **キュー**で進捗と各ジョブの保存先を確認します。

対応デスクトップ環境では認証情報をOSの資格情報保管庫に保存します。NovelAIトークン、R2 secret、private sidecarをIssueへ添付しないでください。

## 主な使い方

### プロンプトモジュール

Guidedまたは高度な生成画面からプロンプトモジュールライブラリを開きます。フォルダーで分類し、ベース、詳細、追加、ネガティブ、キャラクター、キャラクターネガティブの各パートを保存できます。挿入時は必要なパートだけを選択でき、キャラクター座標はモジュールではなく現在のタスクに属します。

### 画像メタデータの読み込み

プロンプト読み込み領域へPNG、WebP、JPEG、`.nai-blue.json` sidecar、または対応するメタデータ抽出JSONをドロップします。メインとキャラクタープロンプトは同じ編集形式へ変換されます。他の自動化ツールから移行できるようNAIS2・NAIS3メタデータを読み込みますが、これらの識別子はインポート境界でのみ認識し、NAI Blueデータとして再保存しません。

### 生成フォルダーとR2

キューへ追加する前に生成フォルダーを作成します。フォルダーごとにローカル保存先、共通プロンプト、R2プロファイル、バケット、プレフィックス、自動アップロードを設定できます。子フォルダーは明示的に上書きしない限り親のプレフィックスを継承します。

R2プロファイルの設定と接続確認が終わるまではR2操作を選べません。**R2を設定**から接続を検証し、必要なフォルダーだけ自動アップロードを有効にしてください。ローカル原本の削除は常に独立した明示的な選択です。

### 画像クリーンアップとsidecar

メタデータステップでは、画像への埋め込み、sidecarのみ、クリーン画像＋private sidecar、完全削除を選べます。クリーンアップはピクセルだけを再エンコードし、復元用メタデータをprivate sidecarへ分離します。設定した権利所有者のXMPも追加できます。

## デバッグと不具合報告

報告前に次を確認してください。

1. 同じ入力でもう一度だけ試し、失敗した正確なステップを記録します。
2. **設定 → 高度な設定と診断**を開きます。
3. 関連イベントを選び、**サニタイズ済み診断ログ**をコピーまたは書き出します。
4. 最新リリースノートと既存の[Issue](https://github.com/bluehair-blue/NAI-Blue/issues)を確認します。

[バグ報告](https://github.com/bluehair-blue/NAI-Blue/issues/new?template=bug_report.yml)には次を含めてください。

- NAI Blueのバージョン、OS、インストール方法
- 最短の再現手順
- 期待した動作と実際の動作
- 表示された`DiagnosticCode`とサニタイズ済みログ
- トークン、パス、プロンプト、privateメタデータを隠したスクリーンショット

NovelAIトークン、Cloudflare secret、署名鍵、生のcredential backup、未確認のprivate sidecarは添付しないでください。脆弱性は公開Issueではなく、リポジトリの非公開Security Advisoryから報告してください。

## ソースからのビルドとデバッグ

Node.js 24 LTS、npm、Rust 1.93以降、Tauriに必要なネイティブビルドツールを用意してください。Tagger sidecarを再ビルドする場合はPython 3.11も必要です。

```bash
git clone https://github.com/bluehair-blue/NAI-Blue.git
cd NAI-Blue
npm ci
npm run tauri dev
```

主な確認コマンド：

```bash
npm run lint
npm run test:composition
npm run build
npm run tauri build
```

リリースと署名の手順は[RELEASING.md](./RELEASING.md)を参照してください。

## クレジットとライセンス

NAI Blueは[NAIS2](https://github.com/sunanakgo/NAIS2)から始まった取り組みを引き継いでいます。原作者とコントリビューターに感謝します。ワイルドカードとシーンのワークフローでは[NAIA2.0](https://github.com/DNT-LAB/NAIA2.0)および[SDStudio](https://github.com/sunho/SDStudio)も参考にしています。

[GPL-3.0](./LICENSE)で提供します。
