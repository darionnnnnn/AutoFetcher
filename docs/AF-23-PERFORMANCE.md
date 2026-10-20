# AF-23 效能證據

本文件記錄 AF-23 E1 量測與 E2 條件優化的可核對結果。所有時間來自本機 Chrome for Testing 真實瀏覽器與隔離的本機 fixture；不是 jsdom 時間。E1 UI 與 scheduler 使用 Chrome for Testing 152.0.7977.82、macOS arm64。量測腳本、原始 JSON/JSONL 產物及檔名列於各節；本輪採用的原始 JSON 已去除本機路徑並收錄於 [`evidence/af23/`](evidence/af23/)。

E1 的門檻依 AF-23 PLAN：picker 本地按鈕回饋 p95 ≤ 100 ms；10,000 筆報表暖篩選與切頁結果 p95 ≤ 300 ms。E2 要求瓶頸指標改善至少 20%，未涉入操作退化不得超過 `max(基線 p95 × 20%, 30 ms)`。以下同時分開呈現「首個可見回饋」與「操作完成結果」，避免把快回饋誤報成整段工作完成。

## Picker 選取、完成與儲存（E1／E2）

最終 E1 picker matrix 為 60 次真實 side panel 使用者操作：三種草稿各 20 次，涵蓋 `(1 組, 1 值)`、`(5 組, 20 值)`、`(20 組, 100 值)`。每個樣本先以真實操作選取一個經 DOM 驗證的 fixture 儲存格；為固定資料量而擴大的其餘值沿用該來源與 spec。這是容量量測，不宣稱涵蓋 100 個不同來源的正確性；每次保存後驗證正式 task/value 數量與預期相符。

最終 Picker source SHA-256 為 `2076e21e9553f32f0d31b684941538ff387415c8552039b26bfdf73ec7baca02`，基線 source SHA-256 為 `24e1de28c0ef7a44d14d3e7390b91019ff4cbbd81cfda83b506bb3cd16ca4817`。每組 20 次暖樣本的 p95 取排序後第 19 個值。

| 草稿大小 | 首個可見狀態 p95（最終） | 舊版首個可見完成結果 p95 | 回饋改善 | 完成結果 p95（舊 → 新） | 儲存結果 p95（舊 → 新） | 群組切換結果 p95（舊 → 新） |
|---|---:|---:|---:|---:|---:|---:|
| 1 組 / 1 值 | 16.6 ms | 49.1 ms | 66.2% | 49.1 → 48.4 ms | 48.9 → 49.3 ms | 不適用 |
| 5 組 / 20 值 | 16.4 ms | 149.1 ms | 89.0% | 149.1 → 149.5 ms | 116.1 → 116.8 ms | 16.8 → 18.0 ms |
| 20 組 / 100 值 | 28.2 ms | 482.2 ms | 94.2% | 482.2 → 482.1 ms | 1048.9 → 1049.0 ms | 46.3 → 28.2 ms |

首個可見狀態的每筆耗時以 `busyFrame.at - completion.startedAt` 計算，再將 20 筆排序取第 19 筆作 p95。`startedAt` 來自真實 click capture，`busyFrame` 是之後實際檢查 UI 的動畫 frame；該 frame 必須觀察到下列其中一種實際 UI 狀態：

- busy：完成按鈕已停用並顯示「正在完成…」，狀態文字為「正在同步選取…」。
- 已完成：若工作快到在 busy frame 前結束，完成按鈕恢復可用且結果列已可見。

60 個樣本都在第一個捕捉 frame 看到上述狀態。1 組 / 1 值是 busy 15/20、已完成 5/20；另外兩組各為 busy 20/20。首個狀態的 p95 都低於 100 ms。舊版沒有一致的立即 busy 狀態，因此改善率是以舊版首個可見完成結果 p95 對比新版首個可見 busy 或已完成狀態 p95 計算；它不是完整提取時間的改善率。

E2 的最小變更是讓完成動作在提取尚未完成時立即顯示明確 busy 狀態。完整完成時間沒有同幅度縮短：20 組 / 100 值的完成結果 p95 仍為 482.1 ms。未涉入操作符合回退限制：群組切換最大退化為 1.2 ms；儲存最大退化為 0.7 ms（其餘兩組分別為 +0.4 ms、+0.1 ms）。各值均不超過對應的 `max(基線 p95 × 20%, 30 ms)`；20 組的切換改善 18.1 ms。I/O 與 listener 計數記錄在原始樣本中，正確性均通過。

UI harness 為 [`tests/smoke/af23_perf_pick_ui.mjs`](../tests/smoke/af23_perf_pick_ui.mjs)。純離線回饋門檻檢查器為 [`tests/smoke/af23_perf_ui_feedback_gate.mjs`](../tests/smoke/af23_perf_ui_feedback_gate.mjs)，命令為 `node tests/smoke/af23_perf_ui_feedback_gate.mjs docs/evidence/af23/perf-pick-ui-final.json`。它讀取既有報告，不開瀏覽器、不重跑 60 個樣本；本輪執行結果為三種草稿都 PASS，回饋 p95 分別為 16.6、16.4、28.2 ms，且每個樣本都具備可見 busy 或完成狀態。原始報告檔名：`docs/evidence/af23/perf-pick-ui-final.json`；基線：`docs/evidence/af23/perf-pick-ui-baseline-qa-old.json`。

## Picker hover（E1）

1000 列 × 10 欄 fixture、seed 0，在可見且聚焦的真實 Chromium 頁面完成 20 次 hover：p50 29.86 ms、p95 31.57 ms、max 34.21 ms，20/20 正確。環境 fingerprint 記錄瀏覽器、fixture、source 路徑與可見／聚焦狀態，但沒有 source-content hash，不能視為內容指紋。

另有一次獨立診斷：mouse move 12.18 ms、事件 capture 到 bubble 約 0.9 ms，最長觀察到的 renderer RunTask 為 4.84 ms。這是單次診斷，不併入 hover 20 筆分布；目前沒有證據將早先 RAF timeout 歸因於 content renderer 長任務。原始檔名：`work/perf-pick-hover.json`、`work/perf-pick-hover-samples.jsonl`；單次診斷在 `work/repair/work/hover-diagnostic.json` 及 trace 檔。

## Scheduler 容量矩陣（E1）

最終組合保留 85 筆舊 QA 樣本，並以當前 source hash `f263823c58b589a86df417dcdce31f752185dac31c72251c8c3fb6fd2c9ce72f` 新測 15 筆冷啟動樣本，總數 100。15 筆冷樣本涵蓋前三個固定場景，各 5 次；所有樣本正確性通過。

| 冷樣本場景（新測 15 筆） | 冷端到端 median / max | 對應保留舊 QA 暖樣本 p50 / p95 |
|---|---:|---:|
| 1 站 × 2 任務 × 每任務 1 值 | 7100.65 / 7107.15 ms | 6864.94 / 7124.71 ms（20 筆） |
| 5 站 × 2 任務 × 每任務 20 值 | 7307.00 / 7362.33 ms | 7294.20 / 7432.12 ms（20 筆） |
| 20 站 × 2 任務 × 每任務 20 值 | 9414.99 / 9473.56 ms | 9756.80 / 14208.05 ms（20 筆） |
| 1 站 × 1 任務 × 100 值（保留 QA） | 3906.98 / 3961.25 ms | 3699.81 / 3968.93 ms（20 筆） |

保留的 85 筆組成為前三場景的 60 筆暖樣本，加上「1 站 × 1 任務 × 100 值」的 5 筆冷與 20 筆暖樣本。原報告另有前三場景舊的 15 筆冷樣本；它們仍留在歷史報告，但最終 100 筆組合以新測且具 source fingerprint 的 15 筆取代，不重複計入。

這 85 筆原始列與舊報告沒有記錄執行當下的 source hash，不能宣稱與新 15 筆或 UI 最終版同 hash。主代理另比對 `cd835c1..QAHEAD`：對這些 scheduler fixture 有關的 backend、storage、content main 與 extract 範圍，差異只有 `shared/extract.js` 的 8 行 canonical-cell 處理；這些 scheduler fixture 使用 scalar spec，不會走該 cell 分支。因此主代理判定舊 85 筆可沿用為本矩陣資料，但 source hash 仍是未知，不能升格為同一 build 的證據。

每個 task 的執行 deadline 為 150,000 ms。`RUN_TASK` 沒有精確 enqueue/dequeue 時間戳；分開的單樣本診斷有頁面完成時間與依前一個 response 推估的 per-origin queue wait，不能稱為精確排隊時間。此次沒有修改 scheduler，因此 E3 的跨站並行上限、公平性與新排程設計驗收標示為 **N/A**，不解讀成新設計通過。量測也不支持「新並行策略帶來效能改善」的結論。

E1 scheduler harness：[`tests/smoke/af23_perf_schedule.mjs`](../tests/smoke/af23_perf_schedule.mjs)。原始檔名：`work/perf-schedule-cold-retest.json`、`work/perf-schedule-samples.jsonl`、`work/perf-schedule.json`、`work/perf-schedule-diagnostic.json`。

## 報表 1k / 10k / 100k（E1；E2 未觸發）

報表量測來自另一份完成報告：commit `e81b3dd862158fe4c0b5a23afacdc831873879c4`、extension version `0.21.0`、Chrome 152.0.7977.82。每一資料量冷開啟 5 次，暖操作每種 20 次；三種資料量的結果正確率均為 100%。這份報告記錄 commit，但沒有可重建的 source-content hash。

| 歷史筆數 | 冷 dashboard open median / max | 暖篩選回饋 / 結果 p95 | 暖切頁回饋 / 結果 p95 | 收到新紀錄結果 p95 | 篩選 storage get（次 / bytes） | 篩選讀歷史紀錄次數 |
|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | 55.6 / 63.7 ms | 14.17 / 14.17 ms | 14.8 / 81.4 ms | 89.27 ms | 4 / 332 | 0 |
| 10,000 | 80.1 / 84.6 ms | 13.5 / 13.5 ms | 14.6 / 98.0 ms | 110.37 ms | 4 / 3086 | 0 |
| 100,000 | 372.3 / 384.3 ms | 31.13 / 48.4 ms | 14.5 / 130.6 ms | 487.1 ms | 4 / 9286 | 0 |

10k 暖篩選與切頁結果 p95 都低於 300 ms；所有按鈕回饋 p95 都低於 100 ms。100k 收到新紀錄的 487.1 ms 是非同步結果完成時間，不是按鈕回饋門檻。歷史啟用與完整 report sample 亦記錄在原始報告中；此表不把不同操作的完成時間互相代替。報告原始檔名：`work/perf-report.json`。

此報表沒有證據顯示超出既有設計限制的可歸因瓶頸，因此 E2 不對 report 增加額外優化。E3 只針對 scheduler 變更，與這份報表無關。

## 範圍與重現界線

- 這些量測是固定本機 fixture 與 CfT 環境的樣本結果，不是對所有網站、資料形狀或使用者硬體的保證。
- Picker 容量 gate 每筆樣本只有一個實際選取來源；放大量沿用相同來源/spec。獨立來源的正確性由其他功能流程驗證，不能從這組 sizing matrix 推導。
- Scheduler 的新 15 筆冷樣本有 source 與 browser fingerprint；舊 85 筆沒有 execution-time source hash。程式差異分析支持 scalar fixture 沿用，但不能補回缺失的歷史 fingerprint。
- Queue wait 無精確 API 時戳；150 秒是每個 task 的執行 deadline，不是 queue deadline，也不證明排隊不計入 deadline。
- E3 沒有調度變更，故 N/A；沒有宣稱新的 scheduler concurrency/fairness 行為通過。
- 最終採用的六份原始 JSON 收錄於 `docs/evidence/af23/`；JSONL 是相同樣本的過程紀錄，非最終判定依據。Picker feedback gate 可離線重算，不需要重跑瀏覽器。
