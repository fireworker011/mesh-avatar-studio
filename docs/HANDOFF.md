# 引き継ぎ: 全身アバターの 2.5D 仕上げ

次の担当は、以下をそのまま指示として使う。

---

あなたは Mesh Avatar Studio の全身アバターの仕上げ担当である。リポジトリは fireworker011/mesh-avatar-studio、ブランチは cursor/full-body-avatars-2ec6、PR は #1（ベースは main）。新しいブランチは切らない。直したらこのブランチにコミットしてプッシュし、PR #1 の説明を更新する。報告では、見た絵に残っている欠陥を先に書く。「人間のように駆動した」とは書かない。

## 目的

全身の立ち絵（samples/full-body-vest、samples/full-body-coat、samples/full-body-photo）を、カメラや姿勢で手足を動かしても立ち絵の構図が残る 2.5D の切り抜き人形にする。胴・コート・スカートは描かれたまま残し、関節から先だけが切り抜いた形のまま回る。そのうえで口と閉じ目の絵を直し、最後に全身のときだけ、髪が顔・肩・胸にめり込まない制約を足す。人間の骨格や肉は再現しない。

## 終わったこと

このブランチの直近 3 コミット。

- ba57e67 関節の較正。3 サンプルの肩・肘・手首・膝・足首を、描かれた袖とズボンの中心線、袖口と裾の位置に合わせた。変えたのは rig.json の値だけで、フィールドの意味は変えていない。
- 45cfd84 手足の切り抜き化。
  - tools/build_body_parts.py を作り直した。手足を元絵の画素から分水嶺で切り出し、関節で分け、静止時に隠れている部分だけを塗る。隠れている部分とは、親の下の付け根、スカートやコートの下の太もも、長い髪の下の袖、袖の後ろのコートやシャツの脇である。塗るのはその層自身の画素から（同じ布どうしの関節では親の画素そのもの）。全レイヤーを描画順に重ねると元絵に一致し、実行のたびに `rest max delta 0.00` を表示する。
  - base.png は元絵のまま。切り抜いた胴は parts/base_cut.png。パーツを知らない古いランタイムは base.png をそのまま描く。
  - ランタイム（packages/runtime/src/engine/ の rig.js、body-parts.js、renderer.js、createMeshAvatar.js、physics.js）は、parts.json に `cutout` があるときだけ胴を手足の骨でスキニングしない。
    - 手足はパーツごとに 1 つの剛体変換（rig.js の `partFrame`）で動き、親が子の付け根の上に描かれる。
    - 肩キャップと前髪は腕の上に描く。
    - 体の yaw（bodyAngleX）は、前の腕・胴・奥の腕を奥行きでずらす（rig.js の `YAW_DEPTH`）。奥の腕は胴の下に回る。
    - 顔の angleX で胴やスカートを差し替えない。twist で手足を潰さない。
    - パーツのメッシュは輪郭が 2px のセル（renderer.js の `buildContourGrid`）。
  - バストと、`cutout` の無い全身アバターは前と同じ計算である。
- e50c8b0 確認用のレンダー: tools/review-cutout.mjs と tools/compose_cutout_review.py。
- changeset は .changeset/cutout-limbs.md（minor）を足し、.changeset/body-parts.md の文言を今の動作に合わせた。

## この回で足したこと

- 隠れ部分の塗りを Telea から、その層の画素の継続に変えた。マットの薄灰色は袖に載せない。親の端のフェードを、子が同じ画素を持っている帯で 0 まで伸ばした。
- 口は元の唇の画素から `mouth_a` `mouth_a_half` `mouth_i` `mouth_u` `mouth_e` `mouth_o` を別々に描く。`ImageDraw.ellipse` は使っていない。シートに `mouth_e` / `mouth_u` が無いバストは、いままで通り half あ の横伸ばしと お の幅縮み（Sprite regression 0 px）。
- 閉じ目は目ごとに測ったまつ毛の芯の太さで、開口部の内側に 1 本。眉は lash レイヤーから、まつ毛の筋と分かれているものだけ写す。
- 全身の房の点は、頭・肩・胸の楕円へ休止位置より深く入らない。バストの物理にはこの処理を入れていない。胸の画素は押していない。
- photo の hairmask はシャツとズボンと顔の肌を外した（90292 px → 21994 px）。backL / backR は y=562 のまま。シャツの画素は髪ではないので、房と一緒には揺れない。
- `parts.json` の `cutout` が指すレイヤーを validate する。型エラー 6 件は直した。確認フレームに拳・裏・twist を足した。

## 残っている粗と再現方法

再現はすべて次の 2 行で出る。出力は work/cutout-review/ で、git には入らない。

```sh
node tools/review-cutout.mjs
uv run --with pillow tools/compose_cutout_review.py --tag check
```

開くファイルは work/cutout-review/check-<サンプル>-poses.png、-joints.png、-detail.png、-face.png。

見た絵にまだ残っているもの。

1. photo の閉じ目・半目・笑顔。肌と合わない淡い楕円は消えた。線は測ったまつ毛の太さの 1 本で、小さな目ではまだ短い棒に見える。眉は残る。元のまつ毛の棘は閉じ目に写していない。
2. coat の閉じ目。線と眉は残り、まぶたの上に塗っていた淡い斑は消えた。半目は虹彩が見える。まぶた側は元絵の肌で、別のぼかしは載っていない。
3. photo の口。あ・え・お は元の唇が開くが、中が平らな暗い塗りで、口の脇に肌色のパッチが出る。い は元の唇に近い細い開きで、変化が小さい。
4. photo の上げた袖の内側は、まだ段のついた縁である。yaw の肩とシャツに白い点がある。sit の股は暗いギザギザの形、knee はズボンを横切る直線の切れ目が見える。
5. coat の sit の股は、明るい灰色の四角ではなくなったが、暗い幾何学的なパッチのままである。yaw の肩に白い点が 1 つある。
6. vest の肘と膝に、陰影の段差として直線の切れ目が残る。yaw の肩に点が 1 つある。
7. 拳は同じ手を指先側へ縮めた絵、裏は同じ切り抜きをぼかした絵である。別の絵ではない。vest の拳は、見ると開いた手に近い。
8. 胸の画素を押す衝突は未実装のままである。髪の房の点が頭・肩・胸の楕円へ休止より深く入らない制約はある。揺らしの確認シートは出していない。制約は 90 フレームの単体テストで見ている。
9. 実際のカメラ入力では確かめていない。

## 確認に使うスクリプトとコマンド

```sh
npm run lint
npm test
npm run build
npm run build:runtime
npm run build:element
npm run build:react
npm run e2e        # 長い。先に npx playwright test e2e/full-body.spec.ts e2e/engine.spec.ts
uv run --with numpy --with pillow --with opencv-python-headless tools/test_build_layers.py
uv run tools/test_agent_tools.py
uv run --with numpy --with pillow --with opencv-python-headless tools/build_body_parts.py --debug work/parts-debug
npm run validate-avatar -- samples/full-body-vest      # coat と photo も
node tools/review-cutout.mjs
uv run --with pillow tools/compose_cutout_review.py --tag <毎回別の名前>
```

- build_body_parts.py は 1 回 10 秒ほどかかる。`--debug` を付けると work/parts-debug/<サンプル>-segments.png と -seeds.png が出る。segments は切り分けで、黄が隠れ部分、水色が肩キャップ、桃が袖の後ろの胴。seeds は分水嶺の種。
- サンプルごとの判断は build_body_parts.py の先頭の `SAMPLES` にある（torso_over_arms、leg_from、hair、style）。
- review-cutout.mjs は全パラメータを既定値で固定してから描く。固定しないと auto モーションで腕が揺れ、静止フレームを比べられない。表示する rest frame vs no-parts frame は、パーツ付きの静止フレームとパーツ無しの同じアバターの差で、WebGL の丸めで数レベル出る。

## 合格の基準

次をすべて満たしたら終わり。

1. `npm test` が全部通り、ログに次の 3 行がこの値のまま出る。
   - `Regression: 14 poses, 73975 sample points, max delta 0 px`
   - `Sprite regression: 10 layers, max delta 0 px`
   - `Physics regression: 120 frames, max delta 5.684341886080802e-14 px`
2. `npm run lint`、`npm run build`、`npm run build:runtime`、`npm run build:element`、`npm run build:react` がすべて終了コード 0。`npm run e2e` は、main でも失敗する既知の 4 件（avatar-archive、lighting-presets、lighting のライブドラッグ、live-streaming。PR #1 の説明に記載）以外が通る。
3. build_body_parts.py が 3 サンプルとも `rest max delta 0.00` を出す。review-cutout.mjs が出す rest frame の差が 3 サンプルとも 15 以下。
4. 3 サンプルの check-*-poses、joints、detail、face を自分で開いて、次のどれもが見当たらない。
   - 胴の柄が腕や脚へ流れる。肩が切れる。裾が脚と一緒に伸びる。コートが歪んで矩形が載る。
   - 元の手足の位置に残る線や点。上げた腕の跡に残る白い帯。ギザギザの切り口。平らな灰色の四角。
   - ミトン。楕円の口。二重のまつ毛。目尻からのはみ出し。目の下のにじみ。
   - 体の中に残った髪。胸の衝突で伸びた服の画素。
5. 口: mouth_a、mouth_a_half、mouth_i、mouth_u、mouth_e、mouth_o が元絵の画素から別々に描かれていて、ImageDraw.ellipse を使っていない。sprites.js の `MOUTH_SHAPES` に e と u があり、シートに mouth_e と mouth_u が無いアバター（バスト）は今の対応のまま（Sprite regression 0 px）。唇の位置は vest 424,279.2、coat 350,165.8、photo 148.5,128.2 付近のまま。元の唇の線が開いた口の横に残らない。
6. 閉じ目: 線は 1 本。太さは開いたまつ毛を左右別々に測った値で、開口部の内側だけに描かれ、目尻の外に出ない。eyes_half と eyes_smile も同じ。眉は残り、目の下のにじみは見えない。
7. 髪: 全身のときだけ、房の点が頭・肩・胸の形の中へ休止位置より深く入らないことを確かめる単体テストがある。Physics regression は 1 の値のまま。髪を揺らしたフレームで、顔と胸へのめり込みが無い。photo の hairmask とシャツの揺れをどう扱ったかを報告に書く。
8. 胸の衝突は実装せず、未実装と報告する。
9. packages/ を変えたなら minor の changeset がある。PR #1 の説明が今の状態になっていて、残った欠陥が先頭に書かれている。

## やってはいけないこと

- カメラ追跡、リターゲット、足の接地（3df9260、d52dc12、0ce5766 の層）を作り直さない。
- バスト（samples/miko-qipao）、samples/full-body、reference/ を変更しない。バストの変形回帰は 0 px、物理の回帰はバストの経路で今と同じ値を保つ。衝突をバストの計算に混ぜてから結果を打ち消す、は不可。
- 既存の rig フィールドと既存のスプライト名の意味を変えない。新しいものは足す。
- base.png をパンチした絵で上書きしない（パーツを知らない古いランタイムで手足が消える）。切り抜いた胴は parts/base_cut.png に置く。base.png が壊れたら `git show 0ce5766:samples/<name>/built/base.png` で戻す。
- 中央値で塗ったカプセルや新しいカプセルを base の上に出さない。angleX で胴・コート・スカートを差し替えない。手足を twist で潰さない。
- 胸の画素を押さない（胸と服は一枚の絵）。肩甲骨、背骨のしなり、筋肉、柔らかい胸を作らない。
- 外部の画像生成を使わない。絵をリポジトリの外へ出さない。絵は元のイラストの画素から作る。
- projects/ と work/ をコミットしない。
- 「静止の差が 0」「唇の上にある」「穴がない」を合格の条件にしない。絵を見て、却下できるかどうかで判断する。
- ファイルの編集と、それに依存するビルドやレンダーを、同じ並列ツール呼び出しに入れない。古いコードで走った結果を見ることになる。レビュー画像は毎回別の `--tag` で出す。同じ名前のファイルだと、前の画像を読んでしまうことがある。
