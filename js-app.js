const STORAGE_KEY = 'vocab-plan-entries';
const LEECH_KEY = 'vocab-leech-words';
const SCORE_KEY = 'vocab-score-records';
const ANALYSIS_KEY = 'vocab-weakness-analysis';
const DAILY_PROGRESS_KEY = 'vocab-daily-progress'; // 日別進捗記録
const WEEKDAYS = ['日','月','火','水','木','金','土'];
const DEFAULT_WEEKDAYS = [1,2,3,4,5,6];
const DEFAULT_INTERVALS = [1,3,7,14];
const LEECH_INTERVALS = [1,3,7,14];
const LEECH_WARN_THRESHOLD = 2;
const COLORS = { ink:'#1E2A44', gold:'#a97c1f', red:'#B23A2E', success:'#3a6b4c', grid:'#CBD5E3' };
/* ---------- 参考書用の変数 ---------- */
const REF_STORAGE_KEY = 'vocab-reference-entries';
/* ---------- 復習の完了チェック用 ---------- */
// 「復習日ごとに、その項目をクリアできたか」を記録しておくためのキー。
// ここに入っている項目＝クリア済み。入っていない項目は「まだクリアしていない」とみなす。
const REVIEW_DONE_KEY = 'vocab-review-done';


let entries = [];
let leechWords = [];
let scoreRecords = [];
let scoreChartInstance = null;
let deviationChartInstance = null;
let refEntries = []; // 参考書の予定を保存する配列
let reviewDoneSet = new Set(); // クリア済みの復習項目キーの集合
// 日別進捗記録: [{ id, date, entryId, type:'word'|'book', plannedStart, plannedEnd, actualEnd, bookName? }]
let dailyProgress = [];

// ── 復習インターバルの階層スタイルを返すヘルパー ──────────────
function getIntervalTier(interval) {
  if (interval <= 1) return 1;
  if (interval <= 3) return 2;
  if (interval <= 7) return 3;
  return 4;
}
function getIntervalTierStyle(interval) {
  const t = getIntervalTier(interval);
  return [
    null,
    { bg:'#dbeafe', color:'#1e40af', border:'#93c5fd', label:'Lv.1 初期',  labelShort:'Lv.1' },
    { bg:'#d1fae5', color:'#065f46', border:'#6ee7b7', label:'Lv.2 定着',  labelShort:'Lv.2' },
    { bg:'#fef3c7', color:'#92400e', border:'#fcd34d', label:'Lv.3 強化',  labelShort:'Lv.3' },
    { bg:'#fee2e2', color:'#991b1b', border:'#fca5a5', label:'Lv.4 仕上げ', labelShort:'Lv.4' },
  ][t];
}
function reviewLegendHTML() {
  return `<div class="review-legend">
    <span class="review-legend-label">🎯 復習ステップ：</span>
    <span class="review-legend-badge tag-review-t1">Lv.1 初期 <small>1日後</small></span>
    <span class="review-legend-badge tag-review-t2">Lv.2 定着 <small>3日後</small></span>
    <span class="review-legend-badge tag-review-t3">Lv.3 強化 <small>7日後</small></span>
    <span class="review-legend-badge tag-review-t4">Lv.4 仕上げ <small>14日後〜</small></span>
    <span style="color:var(--ink-soft); margin-left:4px; font-size:.68rem;">数字が大きいほど記憶定着の山場です</span>
  </div>`;
}
// ──────────────────────────────────────────────────────────────

// ── STEP 8：統一バッジ生成ヘルパー ────────────────────────────

/**
 * 「未完了繰越」バッジのHTMLを返す（テーブルビュー・カードビュー共通）
 * @param {string|null} originalDate - 元の予定日（'YYYY-MM-DD'）。なければ省略表示
 * @param {string} [cls='carry-badge'] - 付与するクラス名
 */
function buildCarryBadgeHtml(originalDate, cls = 'carry-badge') {
  const datePart = originalDate ? ` [${originalDate}]` : '';
  return `<span class="${cls}" style="background:#fff7ed;color:#9a3412;border-color:#fed7aa;">⚠️ 未完了繰越${datePart}</span>`;
}

/**
 * 「復習」バッジのHTMLを返す（テーブルビュー・カードビュー共通）
 * @param {number} interval    - 復習インターバル日数（1/3/7/14 等）
 * @param {number} delayedDays - 遅れ日数（0 なら遅れなし）
 * @param {'inline'|'block'}  [layout='inline'] - 'block' ならラベルをブロック要素で包む
 */
function buildReviewBadgeHtml(interval, delayedDays, layout = 'inline') {
  const tier = getIntervalTier(interval);
  const ts = getIntervalTierStyle(interval);
  // 🔁 復習 Lv.X [N日後]
  const mainBadge = `<span style="display:inline-flex;align-items:center;gap:3px;background:${ts.bg};color:${ts.color};border:1px solid ${ts.border};border-radius:4px;padding:1px 6px;font-size:.68rem;font-weight:700;white-space:nowrap;">🔁 復習 Lv.${tier} [${interval}日後]</span>`;
  // 🔄 [遅れN日]（遅れがある場合のみ）
  const delayBadge = delayedDays > 0
    ? `<span style="display:inline-flex;align-items:center;background:#b23a2e;color:#fff;border-radius:4px;padding:1px 6px;font-size:.68rem;font-weight:700;white-space:nowrap;">🔄 [遅れ${delayedDays}日]</span>`
    : '';
  return `${mainBadge}${delayBadge ? ' ' + delayBadge : ''}`;
}
// ──────────────────────────────────────────────────────────────

function pad(n){ return String(n).padStart(2,'0'); }
function formatISO(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function parseISO(s){ const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); }
function addDays(d, n){ const nd = new Date(d); nd.setDate(nd.getDate()+n); return nd; }
function todayISO(){ return formatISO(new Date()); }

/**
 * fromDate から intervalDays 日後以降で、
 * reviewWeekdays に一致する最初の日付を返す。
 * reviewWeekdays が空なら従来通り固定日数で返す。
 * @param {string} fromDate        - 'YYYY-MM-DD' 形式の起点日
 * @param {number} intervalDays    - 加算する日数（DEFAULT_INTERVALS の値）
 * @param {number[]} reviewWeekdays - 許可する曜日の配列（0=日〜6=土）
 * @returns {string} 'YYYY-MM-DD' 形式の復習日
 */
function findNextReviewWeekday(fromDate, intervalDays, reviewWeekdays) {
  const base = addDays(parseISO(fromDate), intervalDays);
  if (!reviewWeekdays || reviewWeekdays.length === 0) {
    return formatISO(base); // フォールバック：従来動作
  }
  for (let i = 0; i < 7; i++) {
    const candidate = addDays(base, i);
    if (reviewWeekdays.includes(candidate.getDay())) {
      return formatISO(candidate);
    }
  }
  return formatISO(base); // 念のためフォールバック
}

/* ---------- 復習の完了チェック／遅れた分だけ1日ずつずらすロジック ---------- */

// 復習項目1件ごとに一意なキーを作る（単語range／参考書rangeごと・間隔日数ごとに固定）
function buildReviewKey(prefix, ownerId, rangeStart, rangeEnd, interval){
  return `${prefix}_${ownerId}_${rangeStart}_${rangeEnd}_${interval}`;
}

function loadReviewDone(){
  try{
    const raw = localStorage.getItem(REVIEW_DONE_KEY);
    reviewDoneSet = raw ? new Set(JSON.parse(raw)) : new Set();
  }catch(e){ reviewDoneSet = new Set(); }
}
function saveReviewDone(){
  try{
    localStorage.setItem(REVIEW_DONE_KEY, JSON.stringify(Array.from(reviewDoneSet)));
  }catch(e){ console.error('Storage error:', e); }
}

// 本来の復習予定日(originalIso)と完了状態から、「実際に表示すべき復習日」を求める。
// ルール：予定日を過ぎてもクリアしていない項目は、次の復習曜日（reviewWeekdays 指定がなければ今日）に移動する。
// 移動先の日付をキーに埋め込んだ movedKey を返すことで、移動のたびにチェック状態がリセットされる。
// 予定日が来ていない、またはすでにクリア済みの項目はずらさない。
function computeEffectiveReviewDate(originalIso, key, reviewWeekdays){
  if(reviewDoneSet.has(key)){
    return { date: originalIso, delayedDays: 0, done: true };
  }
  const todayIso  = todayISO();
  const diffDays  = Math.round(
    (parseISO(todayIso) - parseISO(originalIso)) / 86400000
  );
  if(diffDays <= 0){
    // まだ予定日が来ていない、またはちょうど今日が予定日
    return { date: originalIso, delayedDays: 0, done: false };
  }

  // ★ 遅れた場合：次の復習曜日に移動（reviewWeekdays 未指定時は今日）
  const newDate = reviewWeekdays && reviewWeekdays.length > 0
    ? findNextReviewWeekday(originalIso, diffDays, reviewWeekdays)
    : todayIso;

  // ★ 移動先の日付をキーに埋め込むことで、移動毎にチェック状態をリセット
  const movedKey = `${key}_moved_${newDate}`;

  return { date: newDate, movedKey, delayedDays: diffDays, done: false };
}

// 単語・参考書の全復習項目（本来の日付＋ずらし後の実効日付）をまとめて計算する共通関数。
// renderMergedSchedule / renderIntegratedSchedule の両方から呼ばれる。
// ★ 進捗記録がある場合は computeAdjustedChunksForEntry / computeAdjustedRefSchedule を使い
//   残りのスケジュールを自動再配分する。
function buildAllReviews(){
  const vocabChunks = entries.flatMap(computeAdjustedChunksForEntry);
  const vocabReviews = [];
  vocabChunks.forEach(c => {
    // 進捗記録があるチャンクは進捗ベースの復習を後段で生成するためスキップ
    const hasProgressRecord = dailyProgress.some(p =>
      p.type === 'word' && p.entryId === c.entryId && p.date === c.date
    );
    if (hasProgressRecord) return;
    (c.intervals || []).forEach(n => {
      const originalDate = formatISO(addDays(parseISO(c.date), n));
      const key = buildReviewKey('w', c.entryId, c.rangeStart, c.rangeEnd, n);
      const entryForChunk = entries.find(e => e.id === c.entryId);
      const reviewWeekdays = entryForChunk?.reviewWeekdays || [];
      const eff = computeEffectiveReviewDate(originalDate, key, reviewWeekdays);
      vocabReviews.push({
        date: eff.date, originalDate, rangeStart: c.rangeStart, rangeEnd: c.rangeEnd,
        interval: n, key: eff.movedKey || key, delayedDays: eff.delayedDays, done: eff.done
      });
    });
  });

  // ── 進捗ベースの単語復習（実際に進んだ範囲で DEFAULT_INTERVALS の復習を自動生成）──
  dailyProgress
    .filter(p => p.type === 'word')
    .forEach(p => {
      const entry = entries.find(e => e.id === p.entryId);
      if (!entry) return;
      const reviewWeekdays = entry.reviewWeekdays || []; // ★復習曜日設定を取得
      DEFAULT_INTERVALS.forEach(n => {
        const originalDate = findNextReviewWeekday(p.date, n, reviewWeekdays); // ★曜日ベースに変更
        const key = `w_prog_${p.entryId}_${p.date}_${p.plannedStart}_${n}`;
        const eff = computeEffectiveReviewDate(originalDate, key, reviewWeekdays);
        vocabReviews.push({
          date: eff.date, originalDate,
          rangeStart: p.plannedStart, rangeEnd: p.actualEnd,
          interval: n, key: eff.movedKey || key, entryId: p.entryId,
          delayedDays: eff.delayedDays, done: eff.done
        });
      });
    });

  const refChunks = refEntries.flatMap(plan =>
    computeAdjustedRefSchedule(plan).map(c => ({ ...c, bookName: plan.bookName, planId: plan.id }))
  );
  // 参考書の復習は「進捗入力」をトリガーに生成する。
  // dailyProgress の book タイプレコードを走査し、
  // 実際に記録した日 + DEFAULT_INTERVALS で復習予定を作成する。
  const refReviews = [];
  dailyProgress
    .filter(p => p.type === 'book')
    .forEach(p => {
      // planId があればそれを使い、なければ後方互換として entryId をそのまま試みる
      const resolvedPlanId = p.planId || p.entryId;
      const plan = refEntries.find(r => r.id === resolvedPlanId);
      if (!plan) return;
      const reviewWeekdays = plan.reviewWeekdays || []; // ★復習曜日設定を取得
      const actualStart = p.plannedStart;
      const actualEnd   = p.actualEnd;
      DEFAULT_INTERVALS.forEach(n => {
        const originalDate = findNextReviewWeekday(p.date, n, reviewWeekdays); // ★曜日ベースに変更
        // キー：resolvedPlanId + 記録日 + 記録開始ページ + インターバル で一意に識別
        const key = `r_prog_${resolvedPlanId}_${p.date}_${actualStart}_${n}`;
        const eff = computeEffectiveReviewDate(originalDate, key, reviewWeekdays);
        refReviews.push({
          date: eff.date, originalDate,
          rangeStart: actualStart, rangeEnd: actualEnd,
          interval: n, bookName: plan.bookName,
          planId: resolvedPlanId, key: eff.movedKey || key,
          delayedDays: eff.delayedDays, done: eff.done
        });
      });
    });

  return { vocabChunks, refChunks, vocabReviews, refReviews };
}

/**
 * 過去日付のうち未達成のチャンクを今日に繰り上げて返す。
 *
 * 判定ルール（単語・参考書共通）:
 * 1. 最新の進捗記録の actualEnd がこのチャンクの rangeEnd 以上 → 完了とみなしスキップ
 * 2. このチャンクの元日付に対して progress 記録がある → 残量は computeAdjusted* で再配分済みのためスキップ
 * 3. 上記どちらも該当しない → 未達成として今日 (todayISO) に繰り上げ
 */
function getCarryForwardChunks(vocabChunks, refChunks) {
  const todayStr = todayISO();

  const cfVocab = vocabChunks
    .filter(chunk => chunk.date < todayStr)
    .filter(chunk => {
      // 最新進捗がこのチャンクの範囲を全て覆っていれば完了
      const latest = getLatestProgress(chunk.entryId, 'word');
      if (latest && latest.actualEnd >= chunk.rangeEnd) return false;
      // この日付に何らかの進捗記録があれば残量は再配分済み
      // ★ composite key 新形式（originEntryId）・旧形式（entryId）の両方に対応
      const hasRecord = dailyProgress.some(p =>
        p.date === chunk.date && p.type === 'word' &&
        (p.originEntryId || p.entryId) === chunk.entryId
      );
      return !hasRecord; // 記録なし → 繰り上げ対象
    })
    .map(chunk => ({ ...chunk, date: todayStr, carriedForward: true, originalDate: chunk.date }));

  const cfRef = refChunks
    .filter(chunk => chunk.date < todayStr)
    .filter(chunk => {
      const latest = getLatestProgress(chunk.planId, 'book');
      if (latest && latest.actualEnd >= chunk.rangeEnd) return false;
      // 新形式（複合キー）または旧形式（planIdそのまま）どちらの記録も検出する
      const hasRecord = dailyProgress.some(p => {
        if (p.type !== 'book' || p.date !== chunk.date) return false;
        const resolvedPlanId = p.planId || p.entryId;
        return resolvedPlanId === chunk.planId;
      });
      return !hasRecord;
    })
    .map(chunk => ({ ...chunk, date: todayStr, carriedForward: true, originalDate: chunk.date }));

  return { cfVocab, cfRef };
}

/**
 * 繰り上げ（carry-forward）されたチャンクに紐づく復習日を、新しい学習日基準に再計算する。
 * 繰り上げ前の学習日から算出された復習予定は削除し、繰り上げ後の日付 + インターバルで再生成する。
 */
function isReviewFromOriginalSchedule(review, cfChunk, type) {
  const ownerId = type === 'word' ? cfChunk.entryId : cfChunk.planId;
  const prefix = type === 'word' ? 'w' : 'r';
  const expectedKey = buildReviewKey(prefix, ownerId, cfChunk.rangeStart, cfChunk.rangeEnd, review.interval);
  if (review.key !== expectedKey) return false;
  const expectedOriginal = formatISO(addDays(parseISO(cfChunk.originalDate), review.interval));
  return review.originalDate === expectedOriginal;
}

function adjustReviewsForCarryForward(vocabReviews, refReviews, cfVocab, cfRef) {
  const filteredVocabReviews = vocabReviews.filter(r =>
    !cfVocab.some(cf => isReviewFromOriginalSchedule(r, cf, 'word'))
  );
  // 参考書の復習は進捗記録ベースで生成されるため、cfRef による調整は不要
  const filteredRefReviews = refReviews;

  cfVocab.forEach(c => {
    (c.intervals || []).forEach(n => {
      const originalDate = formatISO(addDays(parseISO(c.date), n));
      const key = buildReviewKey('w', c.entryId, c.rangeStart, c.rangeEnd, n);
      const entryForCf = entries.find(e => e.id === c.entryId);
      const reviewWeekdays = entryForCf?.reviewWeekdays || [];
      const eff = computeEffectiveReviewDate(originalDate, key, reviewWeekdays);
      filteredVocabReviews.push({
        date: eff.date, originalDate, rangeStart: c.rangeStart, rangeEnd: c.rangeEnd,
        interval: n, key: eff.movedKey || key, delayedDays: eff.delayedDays, done: eff.done
      });
    });
  });

  // cfRef は進捗記録ベースの復習生成に統合されるためここでは追加しない

  return { vocabReviews: filteredVocabReviews, refReviews: filteredRefReviews };
}

/**
 * スケジュール描画用の共通データ（チャンク・繰り上げ・復習調整済み）をまとめて返す。
 */
function buildScheduleData() {
  const { vocabChunks: rawVocabChunks, refChunks: rawRefChunks, vocabReviews, refReviews } = buildAllReviews();
  const { cfVocab, cfRef } = getCarryForwardChunks(rawVocabChunks, rawRefChunks);
  const adjusted = adjustReviewsForCarryForward(vocabReviews, refReviews, cfVocab, cfRef);
  return {
    rawVocabChunks,
    rawRefChunks,
    vocabChunks: [...rawVocabChunks, ...cfVocab],
    refChunks: [...rawRefChunks, ...cfRef],
    cfVocab,
    cfRef,
    vocabReviews: adjusted.vocabReviews,
    refReviews: adjusted.refReviews
  };
}

// 復習チェックボックスにクリックイベントを設定する共通関数。
// チェック/解除のたびに保存し、全スケジュール表示を再描画する。
function attachReviewCheckHandlers(container){
  if(!container) return;
  container.querySelectorAll('.review-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.key;
      if(cb.checked){ reviewDoneSet.add(key); } else { reviewDoneSet.delete(key); }
      saveReviewDone();
      refreshAllSchedules();
      renderIntegratedSchedule();
      renderRefTodayCard(); // 参考書「今日やること」カードを同期更新
    });
  });
}

/* ---------- 日別進捗（保存・読み込み） ---------- */
function loadDailyProgress() {
  try {
    const raw = localStorage.getItem(DAILY_PROGRESS_KEY);
    dailyProgress = raw ? JSON.parse(raw) : [];
  } catch(e) { dailyProgress = []; }
}
function saveDailyProgress() {
  try {
    localStorage.setItem(DAILY_PROGRESS_KEY, JSON.stringify(dailyProgress));
  } catch(e) { console.error('Storage error:', e); }
}

/**
 * 特定エントリ・日付の進捗レコードを返す（最新1件）
 * book タイプの場合は planId でも照合する（後方互換 + 新形式の両方に対応）
 */
function getLatestProgress(entryId, type) {
  const records = dailyProgress
    .filter(p => {
      if (p.type !== type) return false;
      if (type === 'book') {
        // planId が一致、または entryId が一致（後方互換）、または entryId が planId で始まる（複合キー）
        const resolvedPlanId = p.planId || p.entryId;
        return resolvedPlanId === entryId || p.entryId === entryId;
      }
      // word: originEntryId（composite key 新形式）または entryId（旧形式）で照合
      return (p.originEntryId || p.entryId) === entryId;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
  return records[0] || null;
}

/**
 * 進捗記録を考慮してチャンクを再計算する（単語用）
 * - 未完了分を翌学習日（futureChunks[0]）に先頭追加し、残りを均等再配分する
 * - 将来チャンクがない場合は翌曜日一致日に新規タスクとして生成する
 */
function computeAdjustedChunksForEntry(entry) {
  const latest = getLatestProgress(entry.id, 'word'); // originEntryId でフィルタ
  if (!latest) return computeChunksForEntry(entry);

  const originalChunks = computeChunksForEntry(entry);
  const pastChunks = originalChunks.filter(c => c.date <= latest.date);
  const futureChunks = originalChunks.filter(c => c.date > latest.date);

  const actualEnd = latest.actualEnd;
  const totalEnd  = entry.endNum;

  if (actualEnd >= totalEnd) return pastChunks; // 全完了

  const remaining = totalEnd - actualEnd;

  if (futureChunks.length === 0) {
    // 将来チャンクがない場合：翌学習日として最初の曜日一致日を生成
    const nextDate = findNextStudyDay(latest.date, entry.weekdays);
    return [
      ...pastChunks,
      {
        date: nextDate,
        rangeStart: actualEnd + 1,
        rangeEnd: totalEnd,
        entryId: entry.id,
        intervals: entry.intervals,
        isCarriedNew: true // ★未完了由来の新規タスクフラグ
      }
    ];
  }

  // ★ 翌学習日（futureChunks[0]）に未完了分をまとめて先頭追加し、残りを均等配分
  const base = Math.floor(remaining / futureChunks.length);
  const rem  = remaining % futureChunks.length;
  let cursor = actualEnd + 1;

  const newFutureChunks = futureChunks.map((c, idx) => {
    const count = base + (idx < rem ? 1 : 0);
    const rangeStart = cursor;
    const rangeEnd   = cursor + count - 1;
    cursor = rangeEnd + 1;
    return { ...c, rangeStart, rangeEnd, isAdjusted: true,
             isCarriedNew: idx === 0 }; // ★翌学習日チャンクにフラグ
  });

  return [...pastChunks, ...newFutureChunks];
}

// 翌学習日を求めるヘルパー（fromDate の翌日以降で weekdays に一致する最初の日を返す）
function findNextStudyDay(fromDate, weekdays) {
  for (let i = 1; i <= 14; i++) {
    const d = addDays(parseISO(fromDate), i);
    if (weekdays.includes(d.getDay())) return formatISO(d);
  }
  return formatISO(addDays(parseISO(fromDate), 1)); // フォールバック
}

/**
 * 進捗記録を考慮してチャンクを再計算する（参考書用）
 */
function computeAdjustedRefSchedule(plan) {
  const latest = getLatestProgress(plan.id, 'book');
  if (!latest) return computeRefSchedule(plan);

  const originalChunks = computeRefSchedule(plan);
  const pastChunks = originalChunks.filter(c => c.date <= latest.date);
  const futureChunks = originalChunks.filter(c => c.date > latest.date);

  const actualEnd = latest.actualEnd;
  const totalEnd = plan.endNum;

  if (actualEnd >= totalEnd) return pastChunks;
  if (futureChunks.length === 0) return pastChunks;

  const remaining = totalEnd - actualEnd;
  const base = Math.floor(remaining / futureChunks.length);
  const rem = remaining % futureChunks.length;
  let cursor = actualEnd + 1;

  const newFutureChunks = futureChunks.map((c, idx) => {
    const count = base + (idx < rem ? 1 : 0);
    const rangeStart = cursor;
    const rangeEnd = cursor + count - 1;
    cursor = rangeEnd + 1;
    return { ...c, rangeStart, rangeEnd, isAdjusted: true };
  });

  return [...pastChunks, ...newFutureChunks];
}

/**
 * 全完了した場合の残り日数を計算（進捗が良い場合の通知用）
 * returns: 何日早く終わるか（0以下なら早まらない）
 */
function computeEarlyDays(entry, type, actualEnd) {
  if (type === 'word') {
    if (actualEnd < entry.endNum) return 0;
    const originalChunks = computeChunksForEntry(entry);
    if (originalChunks.length === 0) return 0;
    const lastChunk = originalChunks[originalChunks.length - 1];
    const todayD = parseISO(todayISO());
    const lastD = parseISO(lastChunk.date);
    return Math.max(0, Math.round((lastD - todayD) / 86400000));
  } else {
    const plan = refEntries.find(p => p.id === entry.id);
    if (!plan || actualEnd < plan.endNum) return 0;
    const originalChunks = computeRefSchedule(plan);
    if (originalChunks.length === 0) return 0;
    const lastChunk = originalChunks[originalChunks.length - 1];
    const todayD = parseISO(todayISO());
    const lastD = parseISO(lastChunk.date);
    return Math.max(0, Math.round((lastD - todayD) / 86400000));
  }
}

/* ---------- weekly range entries (shared) ---------- */

function buildWeekdayChips(rowId = 'weekdayRow', defaultDays = DEFAULT_WEEKDAYS){
  const row = document.getElementById(rowId);
  if(!row) return;
  row.innerHTML = '';
  WEEKDAYS.forEach((label, idx) => {
    const chip = document.createElement('label');
    chip.className = 'chip' + (defaultDays.includes(idx) ? ' checked' : '');
    chip.innerHTML = `<input type="checkbox" value="${idx}" ${defaultDays.includes(idx)?'checked':''}> ${label}`;
    const cb = chip.querySelector('input');
    cb.addEventListener('change', () => chip.classList.toggle('checked', cb.checked));
    row.appendChild(chip);
  });
}

function buildIntervalChips(rowId = 'intervalRow', defaultIntervals = DEFAULT_INTERVALS){
  const row = document.getElementById(rowId);
  if(!row) return;
  row.innerHTML = '';
  [1,2,3,5,7,10,14,21].forEach(n => {
    const chip = document.createElement('label');
    const checked = defaultIntervals.includes(n);
    chip.className = 'chip' + (checked ? ' checked' : '');
    chip.innerHTML = `<input type="checkbox" value="${n}" ${checked?'checked':''}> ${n}日後`;
    const cb = chip.querySelector('input');
    cb.addEventListener('change', () => chip.classList.toggle('checked', cb.checked));
    row.appendChild(chip);
  });
}

function getCheckedValues(rowId){
  return Array.from(document.querySelectorAll(`#${rowId} input:checked`)).map(el => Number(el.value));
}

async function loadEntries(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    entries = raw ? JSON.parse(raw) : [];
  }catch(e){ entries = []; }
}
async function saveEntries(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  }catch(e){ console.error('Storage error:', e); }
}

function computeChunksForEntry(entry){
  const start = parseISO(entry.startDate);
  const total = entry.endNum - entry.startNum + 1;
  const chunks = [];
  
  // 【新機能】1日あたりの量でスケジュールを組むモード
  if (entry.planMode === 'byAmount') {
    let cursor = entry.startNum;
    let daysAdded = 0;
    while(cursor <= entry.endNum) {
      const d = addDays(start, daysAdded);
      // 学習する曜日かどうか判定
      if (entry.weekdays.includes(d.getDay())) {
        const count = Math.min(entry.amountPerDay, entry.endNum - cursor + 1);
        const rangeStart = cursor;
        const rangeEnd = cursor + count - 1;
        chunks.push({ date: formatISO(d), rangeStart, rangeEnd, entryId: entry.id, intervals: entry.intervals });
        cursor = rangeEnd + 1;
      }
      daysAdded++;
      // 安全装置（万が一の無限ループ防止：最大1年）
      if (daysAdded > 365) break;
    }
  } 
  // 【ここから変更】開始日から終了日までの期間で均等割り当て
  else {
    const studyDates = [];
    
    // 過去のデータ（終了日が未設定のもの）は開始日から1週間とするための安全措置
    const end = entry.endDate ? parseISO(entry.endDate) : addDays(start, 6);
    
    // 開始日から終了日までループして、学習する曜日だけをピックアップ
    let cursorDate = new Date(start);
    while (cursorDate <= end) {
      if (entry.weekdays.includes(cursorDate.getDay())) {
        studyDates.push(new Date(cursorDate));
      }
      cursorDate.setDate(cursorDate.getDate() + 1);
    }
    
    if(studyDates.length === 0) return [];
    
    const days = studyDates.length;
    const base = Math.floor(total/days);
    const rem = total % days;
    let cursor = entry.startNum;
    
    studyDates.forEach((d, idx) => {
      const count = base + (idx < rem ? 1 : 0);
      if(count <= 0) return;
      const rangeStart = cursor;
      const rangeEnd = cursor + count - 1;
      chunks.push({ date: formatISO(d), rangeStart, rangeEnd, entryId: entry.id, intervals: entry.intervals });
      cursor = rangeEnd + 1;
    });
  }
  return chunks;
}

function renderEntryList(){
  const list = document.getElementById('entryList');
  list.innerHTML = '';
  if(entries.length === 0) return;
  entries.forEach(entry => {
    const item = document.createElement('div');
    item.className = 'entry-item';
    const wdLabel = entry.weekdays.slice().sort((a,b)=>a-b).map(i=>WEEKDAYS[i]).join('・');
    
    // 期間の表示をスマートに分岐
    let modeText = '';
    if (entry.planMode === 'byAmount') {
      modeText = `開始日 ${entry.startDate} (1日${entry.amountPerDay}単語)`;
    } else {
      modeText = entry.endDate ? `${entry.startDate} 〜 ${entry.endDate}` : `開始日 ${entry.startDate} (1週間)`;
    }

    item.innerHTML = `
      <div>
        <span class="rng">${entry.startNum}〜${entry.endNum}</span>
        <div class="meta">${modeText} ／ 学習日: ${wdLabel} ／ 復習: ${entry.intervals.join('・')}日後</div>
      </div>
      <button class="del-btn" data-id="${entry.id}">削除</button>
    `;
    list.appendChild(item);
  });
  list.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      entries = entries.filter(e => e.id !== btn.dataset.id);
      await saveEntries();
      renderAll();
    });
  });
}

// 単語スケジュールと参考書スケジュールをまとめて1つのカレンダーとして描画する共通関数
// 「単語タブ」の #scheduleArea に描画する（参考書タブは renderRefTodayCard で管理）
function renderMergedSchedule(containerId){
  const area = document.getElementById(containerId);
  if(!area) return;

  const { vocabChunks, refChunks, vocabReviews, refReviews } = buildScheduleData();

  if(entries.length === 0 && refEntries.length === 0){
    area.innerHTML = `<div class="empty-state">まだ単語範囲・参考書が登録されていません。上のフォームから追加してください。</div>`;
    return;
  }
  if(vocabChunks.length === 0 && refChunks.length === 0){
    area.innerHTML = `<div class="empty-state">学習曜日が選択されていない範囲があります。設定を確認してください。</div>`;
    return;
  }

  // ── 過去の未達成チャンクは buildScheduleData 内で繰り上げ済み ──

  const today = new Date(); today.setHours(0,0,0,0);
  // 表示は「今日」以降のみ（過去日は非表示）
  let minDate = new Date(today);
  const futureDates = [
    ...vocabChunks.filter(c => parseISO(c.date) >= today).map(c => parseISO(c.date)),
    ...vocabReviews.filter(r => parseISO(r.date) >= today).map(r => parseISO(r.date)),
    ...refChunks.filter(c => parseISO(c.date) >= today).map(c => parseISO(c.date)),
    ...refReviews.filter(r => parseISO(r.date) >= today).map(r => parseISO(r.date)),
    today
  ];
  let maxDate = new Date(Math.max(...futureDates));
  const MAX_DAYS = 45;
  const spanDays = Math.round((maxDate - minDate) / 86400000) + 1;
  let truncated = false;
  if(spanDays > MAX_DAYS){ maxDate = addDays(minDate, MAX_DAYS - 1); truncated = true; }

  const rows = [];
  let cursor = new Date(minDate);
  while(cursor <= maxDate){
    const iso = formatISO(cursor);
    const newItems = vocabChunks.filter(c => c.date === iso);
    const reviewItems = vocabReviews.filter(r => r.date === iso);
    const refItems = refChunks.filter(c => c.date === iso);
    const refReviewItems = refReviews.filter(r => r.date === iso);
    if(newItems.length || reviewItems.length || refItems.length || refReviewItems.length){ rows.push({ date: new Date(cursor), iso, newItems, reviewItems, refItems, refReviewItems }); }
    cursor = addDays(cursor, 1);
  }

  const todayIso = todayISO();
  const INITIAL_VISIBLE_ROWS = 3;

  function rowHtml(row) {
    const isToday = row.iso === todayIso;
    const wd = WEEKDAYS[row.date.getDay()];
    const dateLabel = `${row.date.getMonth()+1}/${row.date.getDate()}`;
    return `<tr class="${isToday ? 'today' : ''}">
      <td class="date-cell">${dateLabel}<span class="wd">(${wd})</span>${isToday ? '<span class="today-badge">今日</span>' : ''}</td>
      <td>${row.newItems.map(c => {
        // STEP 8: 未完了繰越バッジを統一形式で表示
        const cfBadge = c.carriedForward ? buildCarryBadgeHtml(c.originalDate) : '';
        const cnBadge = c.isCarriedNew   ? buildCarryBadgeHtml(c.originalDate || null) : '';
        return `<span class="tag tag-new">${c.rangeStart}〜${c.rangeEnd}${cfBadge}${cnBadge}</span>`;
      }).join('') || '—'}</td>
      <td>${row.reviewItems.map(r => {
        // STEP 8: 復習バッジを統一形式で表示（🔁 復習 Lv.X [N日後] + 🔄 [遅れN日]）
        const reviewBadge = buildReviewBadgeHtml(r.interval, r.delayedDays);
        return `<label class="tag tag-review tag-review-t${getIntervalTier(r.interval)} review-check-label${r.done ? ' is-done' : ''}"><input type="checkbox" class="review-check" data-key="${r.key}" ${r.done ? 'checked' : ''}><span class="stamp">◎</span>${reviewBadge} ${r.rangeStart}〜${r.rangeEnd}</label>`;
      }).join('') || '—'}</td>
      <td>${row.refItems.map(c => {
        // STEP 8: 参考書の未完了繰越バッジを統一形式で表示
        const cfBadge = c.carriedForward ? buildCarryBadgeHtml(c.originalDate) : '';
        return `<span class="tag tag-ref">${escapeHtml(c.bookName)} ${c.rangeStart}〜${c.rangeEnd}${cfBadge}</span>`;
      }).join('') || '—'}</td>
      <td>${row.refReviewItems.map(r => {
        // STEP 8: 参考書復習バッジを統一形式で表示
        const reviewBadge = buildReviewBadgeHtml(r.interval, r.delayedDays);
        return `<label class="tag tag-ref-review tag-review-t${getIntervalTier(r.interval)} review-check-label${r.done ? ' is-done' : ''}"><input type="checkbox" class="review-check" data-key="${r.key}" ${r.done ? 'checked' : ''}><span class="stamp">◎</span>${reviewBadge} ${escapeHtml(r.bookName)} ${r.rangeStart}〜${r.rangeEnd}</label>`;
      }).join('') || '—'}</td>
    </tr>`;
  }

  const tableHead = `<thead><tr><th>日付</th><th>単語：新規</th><th>単語：復習</th><th>参考書：新規</th><th>参考書：復習</th></tr></thead>`;
  const visibleRows = rows.slice(0, INITIAL_VISIBLE_ROWS);
  const hiddenRows  = rows.slice(INITIAL_VISIBLE_ROWS);
  const detailsWasOpen = document.getElementById(`schedule-details-${containerId}`)?.open;

  let html = reviewLegendHTML();
  html += `<table>${tableHead}<tbody>`;
  visibleRows.forEach(row => { html += rowHtml(row); });
  html += `</tbody></table>`;

  if (hiddenRows.length > 0) {
    const openAttr = detailsWasOpen !== false ? ' open' : '';
    html += `<details class="schedule-details" id="schedule-details-${containerId}"${openAttr}>
      <summary>残りのスケジュール（${hiddenRows.length}日）</summary>
      <div class="schedule-details-body schedule-wrap">
        <table>${tableHead}<tbody>`;
    hiddenRows.forEach(row => { html += rowHtml(row); });
    html += `</tbody></table></div></details>`;
  }
  if(truncated){ html += `<div class="hint" style="margin-top:8px;">※表示は45日分までです。それ以降は範囲を追加していくと自動で延びます。</div>`; }
  html += `<div class="hint" style="margin-top:8px;">※過去日のスケジュールは非表示です。未達成の新規項目は「今日」に繰り上げられ、それに伴う復習日も自動で再計算されます。4日目以降は「残りのスケジュール」を開いて確認できます。復習はチェックを入れるとクリア済みになります。</div>`;
  area.innerHTML = html;
  attachReviewCheckHandlers(area);
}

function refreshAllSchedules(){
  renderMergedSchedule('scheduleArea');
  // refScheduleOutput は削除済み（参考書タブは renderRefTodayCard で管理）
}

function renderSchedule(){
  refreshAllSchedules();
}

function renderIntegratedSchedule() {
  const container = document.getElementById('integratedScheduleList');
  const wasFutureOpen = document.getElementById('integratedScheduleFuture')?.open;
  container.innerHTML = '';

  // ── 凡例を先頭に挿入 ──────────────────────────────────────────
  container.insertAdjacentHTML('beforeend', reviewLegendHTML());
  // ─────────────────────────────────────────────────────────────

  // 表示日数の決定 (1週間なら7日、1ヶ月なら30日)
  const periodMode = document.querySelector('input[name="schedulePeriod"]:checked').value;
  const targetDays = periodMode === 'week' ? 7 : 30;

  // 単語・参考書の新規チャンクと、復習日（繰り上げ時は自動調整済み）をまとめて取得
  const {
    rawVocabChunks: rawWordChunks,
    rawRefChunks: rawBookChunks,
    vocabChunks: allWordChunks,
    refChunks: allBookChunks,
    vocabReviews: allWordReviews,
    refReviews: allBookReviews
  } = buildScheduleData();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const futureDetails = document.createElement('details');
  futureDetails.className = 'schedule-details';
  futureDetails.id = 'integratedScheduleFuture';
  if (wasFutureOpen !== undefined) {
    futureDetails.open = wasFutureOpen;
  } else {
    futureDetails.open = true;
  }

  const futureBody = document.createElement('div');
  futureBody.className = 'schedule-details-body';
  let futureDayCount = 0;

  function buildDayCard(i, currentLoopDate, dateStr) {
    const dayWords = allWordChunks.filter(chunk => chunk.date.startsWith(dateStr));
    const dayBooks = allBookChunks.filter(chunk => chunk.date.startsWith(dateStr));
    const dayWordReviews = allWordReviews.filter(r => r.date.startsWith(dateStr));
    const dayBookReviews = allBookReviews.filter(r => r.date.startsWith(dateStr));

    if (dayWords.length === 0 && dayBooks.length === 0 && dayWordReviews.length === 0 && dayBookReviews.length === 0 && periodMode === 'month') {
      return null;
    }

    const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][currentLoopDate.getDay()];
    const mm = String(currentLoopDate.getMonth() + 1).padStart(2, '0');
    const dd = String(currentLoopDate.getDate()).padStart(2, '0');

    const dayCard = document.createElement('div');
    dayCard.style.cssText = "background: #fff; border: 1px solid #e0e0e0; border-radius: 8px; padding: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.02); max-width: 100%; overflow: hidden; word-break: break-word;";

    let taskHtml = '';

    dayWords.forEach(w => {
      // STEP 8: 未完了繰越バッジを統一形式で表示
      // 元の計画はバッジなし。carriedForward / isCarriedNew は ⚠️ 未完了繰越 [元日付]
      const carryBadge = w.carriedForward
        ? buildCarryBadgeHtml(w.originalDate)
        : (w.isCarriedNew ? buildCarryBadgeHtml(w.originalDate || null) : '');
      taskHtml += `<div style="margin-top:6px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;"><span style="background:#e3f2fd;color:#0d47a1;padding:2px 6px;border-radius:4px;font-size:0.75rem;font-weight:bold;">単語</span>${carryBadge}<span style="color:#333;font-size:.85rem;">${w.rangeStart} 〜 ${w.rangeEnd}</span></div>`;
    });

    dayBooks.forEach(b => {
      // STEP 8: 参考書の未完了繰越バッジを統一形式で表示
      const carryBadge = b.carriedForward ? buildCarryBadgeHtml(b.originalDate) : '';
      taskHtml += `<div style="margin-top:6px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;"><span style="background:#e8f5e9;color:#1b5e20;padding:2px 6px;border-radius:4px;font-size:0.75rem;font-weight:bold;">参考書</span>${carryBadge}<span style="color:#333;font-size:.85rem;">${escapeHtml(b.bookName)}: ${b.rangeStart} 〜 ${b.rangeEnd}</span></div>`;
    });

    dayWordReviews.forEach(r => {
      // STEP 8: 復習バッジを統一形式で表示
      // 通常: 🔁 復習 Lv.X [N日後]  /  移動済み: 🔁 復習 Lv.X [N日後] + 🔄 [遅れN日]
      const ts = getIntervalTierStyle(r.interval);
      const reviewBadge = buildReviewBadgeHtml(r.interval, r.delayedDays);
      taskHtml += `<div style="margin-top:6px;max-width:100%;overflow:hidden;"><label style="cursor:pointer;display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:6px 9px;border-radius:6px;background:${ts.bg};border:1px solid ${ts.border};${r.done ? 'opacity:.5;text-decoration:line-through;' : ''}"><input type="checkbox" class="review-check" data-key="${r.key}" ${r.done ? 'checked' : ''} style="margin:0;flex-shrink:0;">${reviewBadge}<span style="color:#333;font-size:.8rem;word-break:break-all;">単語 ${r.rangeStart}〜${r.rangeEnd}</span></label></div>`;
    });

    dayBookReviews.forEach(r => {
      // STEP 8: 参考書復習バッジを統一形式で表示
      const ts = getIntervalTierStyle(r.interval);
      const reviewBadge = buildReviewBadgeHtml(r.interval, r.delayedDays);
      taskHtml += `<div style="margin-top:6px;max-width:100%;overflow:hidden;"><label style="cursor:pointer;display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:6px 9px;border-radius:6px;background:${ts.bg};border:1px solid ${ts.border};${r.done ? 'opacity:.5;text-decoration:line-through;' : ''}"><input type="checkbox" class="review-check" data-key="${r.key}" ${r.done ? 'checked' : ''} style="margin:0;flex-shrink:0;">${reviewBadge}<span style="color:#333;font-size:.8rem;word-break:break-all;">${escapeHtml(r.bookName)} ${r.rangeStart}〜${r.rangeEnd}</span></label></div>`;
    });

    if (taskHtml === '') {
      taskHtml = `<div style="color: #999; font-size: 0.85rem; margin-top: 4px;">予定なし</div>`;
    }

    let progressSectionHtml = '';
    if (i === 0) {
      const dayWordsForProgress = rawWordChunks.filter(c => c.date.startsWith(dateStr));
      // 繰り越し分も含めた allBookChunks を使うことで、繰り越し参考書も進捗入力対象にする
      const dayBooksForProgress = allBookChunks.filter(c => c.date.startsWith(dateStr));
      // 未完了の復習タスクも進捗入力対象にする
      const dayWordReviewsForProgress = dayWordReviews.filter(r => !r.done);
      const dayBookReviewsForProgress = dayBookReviews.filter(r => !r.done);
      const hasAnyTask = dayWordsForProgress.length > 0 || dayBooksForProgress.length > 0
                      || dayWordReviewsForProgress.length > 0 || dayBookReviewsForProgress.length > 0;
      if (hasAnyTask) {
        const html = buildProgressInputSection(
          dateStr,
          dayWordsForProgress,
          dayBooksForProgress,
          dateStr,
          dayWordReviewsForProgress,
          dayBookReviewsForProgress
        );
        progressSectionHtml = html || '';
      }
    }

    const hasCFWords  = i === 0 && dayWords.some(w => w.carriedForward);
    const hasCFBooks  = i === 0 && dayBooks.some(b => b.carriedForward);
    const hasCNWords  = i === 0 && dayWords.some(w => w.isCarriedNew);
    const carryForwardBanner = (hasCFWords || hasCFBooks || hasCNWords)
      ? `<div style="margin-bottom:8px;padding:7px 10px;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px;font-size:.78rem;color:#9a3412;font-weight:600;">
           ⚠️ 過去の未達成スケジュールが繰り越されています。
         </div>`
      : '';

    dayCard.innerHTML = `
      <div style="font-weight: bold; font-size: 0.9rem; color: #555; border-bottom: 1px dashed #eee; padding-bottom: 4px;">
        ${mm}/${dd} (${dayOfWeek})${i === 0 ? ' <span style="display:inline-block;font-size:.7rem;background:var(--ink);color:#fff;border-radius:4px;padding:1px 6px;margin-left:4px;">今日</span>' : ''}
      </div>
      <div style="padding-top: 4px;">${carryForwardBanner}${taskHtml}</div>
      ${progressSectionHtml}
    `;

    if (i === 0) {
      const dayWordsForProgress = rawWordChunks.filter(c => c.date.startsWith(dateStr));
      const dayBooksForProgress = allBookChunks.filter(c => c.date.startsWith(dateStr));
      const dayWordReviewsForProgress2 = dayWordReviews.filter(r => !r.done);
      const dayBookReviewsForProgress2 = dayBookReviews.filter(r => !r.done);
      if (dayWordsForProgress.length > 0 || dayBooksForProgress.length > 0
          || dayWordReviewsForProgress2.length > 0 || dayBookReviewsForProgress2.length > 0) {
        attachProgressInputHandlers(dayCard, dateStr);
      }
    }

    return dayCard;
  }

  for (let i = 0; i < targetDays; i++) {
    const currentLoopDate = new Date(today);
    currentLoopDate.setDate(today.getDate() + i);
    const yyyy = currentLoopDate.getFullYear();
    const mm = String(currentLoopDate.getMonth() + 1).padStart(2, '0');
    const dd = String(currentLoopDate.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    const dayCard = buildDayCard(i, currentLoopDate, dateStr);
    if (!dayCard) continue;

    if (i === 0) {
      container.appendChild(dayCard);
    } else {
      futureBody.appendChild(dayCard);
      futureDayCount++;
    }
  }

  if (futureDayCount > 0) {
    const summary = document.createElement('summary');
    summary.id = 'futureScheduleSummary';
    summary.textContent = `今後のスケジュール（${futureDayCount}日）`;
    futureDetails.appendChild(summary);
    futureDetails.appendChild(futureBody);
    container.appendChild(futureDetails);
  }

  if (!container.querySelector('div:not(.review-legend)')) {
    container.innerHTML += '<div style="text-align:center; color:#999; padding:20px;">この期間のスケジュールはありません。設定タブから登録してください。</div>';
  }

  attachReviewCheckHandlers(container);

  // 今日のサマリーカードを更新
  updateTodaySummaryCard();
}

/* ---------- 今日のサマリーカード更新 ---------- */
function updateTodaySummaryCard() {
  const todayStr = todayISO();

  // 日付表示
  const dateEl = document.getElementById('todaySummaryDate');
  if (dateEl) {
    const d = new Date();
    const weekLabel = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
    dateEl.textContent = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日（${weekLabel}）`;
  }

  const {
    vocabChunks,
    refChunks,
    vocabReviews,
    refReviews
  } = buildScheduleData();

  // 今日の単語数（繰り越し含む）
  const todayWords = vocabChunks.filter(c => c.date.startsWith(todayStr));
  let totalWords = 0;
  todayWords.forEach(w => { totalWords += w.rangeEnd - w.rangeStart + 1; });

  // 今日の参考書ページ数（繰り越し含む）
  const todayBooks = refChunks.filter(c => c.date.startsWith(todayStr));
  let totalPages = 0;
  todayBooks.forEach(b => { totalPages += b.rangeEnd - b.rangeStart + 1; });

  // 今日の未完了復習件数
  const todayWordReviews = vocabReviews.filter(r => r.date.startsWith(todayStr) && !r.done);
  const todayBookReviews = refReviews.filter(r => r.date.startsWith(todayStr) && !r.done);
  const totalReviews = todayWordReviews.length + todayBookReviews.length;

  const wordsEl = document.getElementById('ts-words');
  const pagesEl = document.getElementById('ts-pages');
  const reviewsEl = document.getElementById('ts-reviews');
  const allDoneEl = document.getElementById('ts-all-done');

  const hasAnyTask = (todayWords.length > 0 || todayBooks.length > 0 || vocabReviews.filter(r => r.date.startsWith(todayStr)).length > 0 || refReviews.filter(r => r.date.startsWith(todayStr)).length > 0);

  if (wordsEl) wordsEl.innerHTML = totalWords > 0 ? `${totalWords}<span class="ts-unit">語</span>` : `—<span class="ts-unit">語</span>`;
  if (pagesEl) pagesEl.innerHTML = totalPages > 0 ? `${totalPages}<span class="ts-unit">ページ</span>` : `—<span class="ts-unit">ページ</span>`;
  if (reviewsEl) reviewsEl.innerHTML = `${totalReviews}<span class="ts-unit">件</span>`;

  // 全完了バナー
  if (allDoneEl) {
    const allReviewsDone = totalReviews === 0 && hasAnyTask;
    allDoneEl.style.display = allReviewsDone ? 'block' : 'none';
  }
}

/* ---------- 進捗入力 UI ---------- */

/**
 * 今日の単語・参考書チャンクに対する進捗入力セクションのHTMLを返す
 */
/**
 * 今日の単語・参考書チャンクに対する進捗入力セクションのHTMLを返す
 * @param {string} dateStr          - 対象日付 (YYYY-MM-DD)
 * @param {Array}  dayWords         - 当日の単語チャンク（新規）
 * @param {Array}  dayBooks         - 当日の参考書チャンク（新規・繰り越し含む）
 * @param {string} [baseId]         - IDプレフィックス（省略時は dateStr）
 * @param {Array}  [dayWordReviews] - 当日の単語復習タスク
 * @param {Array}  [dayBookReviews] - 当日の参考書復習タスク
 */
/**
 * 進捗入力コントロール（ボタン＋ステッパー方式）のHTMLを返すヘルパー
 * @param {number} rangeStart  - 計画開始番号/ページ
 * @param {number} rangeEnd    - 計画終了番号/ページ
 * @param {string|number} recordedVal - 既存の記録値（空文字 = 未記録）
 * @param {string} type        - 'word' | 'book' | 'word-review' | 'book-review'
 * @param {string} statusHtml  - 既存記録バッジのHTML
 * @param {string} inputAttrs  - hidden input に付与する data-* 属性の文字列
 */
function buildProgControlHtml(rangeStart, rangeEnd, recordedVal, type, statusHtml, inputAttrs) {
  const isWordType  = (type === 'word' || type === 'word-review');
  const unitWord    = isWordType ? '個' : 'ページ';
  const unitLabel   = isWordType ? '番まで' : 'ページまで';
  const plannedCount = rangeEnd - rangeStart + 1;

  const rv       = recordedVal !== '' ? parseInt(recordedVal, 10) : null;
  const isDone   = rv !== null && rv >= rangeEnd;
  const isPartial = rv !== null && rv >= (rangeStart - 1) && rv < rangeEnd;
  const completedCount = rv !== null ? Math.max(0, rv - rangeStart + 1) : 0;
  const pct      = plannedCount > 0 ? Math.min(100, Math.round(completedCount / plannedCount * 100)) : 0;
  const displayVal = rv !== null ? rv : rangeEnd;

  const step1LabelClass = isDone ? ' step-done' : (isPartial ? ' step-partial' : '');
  const isReviewType = (type === 'word-review' || type === 'book-review');
  const extraPages   = rv !== null && rv > rangeEnd ? rv - rangeEnd : 0;
  const extraUnit    = isWordType ? '個追加' : 'ページ追加';

  return `
    <div class="prog-control-ui"
         data-range-start="${rangeStart}"
         data-range-end="${rangeEnd}"
         data-type="${type}">
      <input type="number" class="progress-num-input" style="display:none"
             min="${rangeStart - 1}" max="${rangeEnd + 50}"
             value="${recordedVal}" ${inputAttrs}>
      <div class="prog-step1-label${step1LabelClass}">完了しましたか？</div>
      <div class="prog-toggle">
        <button type="button" class="prog-btn prog-btn-done${isDone ? ' prog-btn-active' : ''}">
          ✅ 完了
        </button>
        <button type="button" class="prog-btn prog-btn-partial${isPartial ? ' prog-btn-active' : ''}">
          ⚠️ 未完了
        </button>
      </div>
      ${statusHtml ? `<div class="prog-status-wrap">${statusHtml}</div>` : ''}
      <div class="prog-partial-panel"${isPartial ? '' : ' style="display:none"'}>
        <div class="prog-partial-heading">どこまで進みましたか？</div>
        <div class="prog-count-row">
          <span class="prog-count-val">${completedCount}</span>
          <span class="prog-count-total">/ ${plannedCount}${unitWord}完了</span>
          <div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="prog-stepper">
          <input type="number" class="prog-display-input"
                 value="${displayVal}"
                 min="${rangeStart - 1}" max="${rangeEnd + 50}"
                 inputmode="numeric" pattern="[0-9]*"
                 aria-label="${unitLabel}入力">
          <span class="prog-unit">${unitLabel}</span>
        </div>
      </div>
      ${!isReviewType ? `
      <div class="prog-extra-panel"${isDone && extraPages > 0 ? '' : ' style="display:none"'}>
        <div class="prog-extra-heading">さらに余剰${isWordType ? '個数' : 'ページ'}はありましたか？</div>
        <div class="prog-extra-options">
          <button type="button" class="prog-extra-no-btn">追加なし</button>
          <div class="prog-extra-input-row">
            <button type="button" class="prog-extra-step" data-delta="-1">−1</button>
            <input type="number" class="prog-extra-input"
                   value="${extraPages}" min="0" max="999" inputmode="numeric">
            <button type="button" class="prog-extra-step" data-delta="+1">+1</button>
            <span class="prog-extra-unit">${extraUnit}</span>
            <button type="button" class="prog-extra-confirm-btn">✅ 記録</button>
          </div>
        </div>
      </div>` : ''}
    </div>`;
}

function buildProgressInputSection(dateStr, dayWords, dayBooks, baseId, dayWordReviews, dayBookReviews) {
  baseId = baseId || dateStr;
  dayWordReviews = dayWordReviews || [];
  dayBookReviews = dayBookReviews || [];
  const existingRecords = dailyProgress.filter(p => p.date === dateStr);
  const hasAnyRecord = existingRecords.length > 0;

  let itemsHtml = '';

  // ── 新規：単語チャンク ──────────────────────────────────────
  dayWords.forEach(w => {
    // ★ composite key：entryId + チャンク本来の日付 + 開始番号（同一単語帳の複数チャンク衝突防止）
    const chunkDate = w.carriedForward ? (w.originalDate || w.date) : w.date;
    const chunkKey  = `${w.entryId}_${chunkDate}_${w.rangeStart}`;

    const rec = existingRecords.find(p => p.entryId === chunkKey && p.type === 'word');
    const recordedVal = rec ? rec.actualEnd : '';
    const plannedCount = w.rangeEnd - w.rangeStart + 1;
    const statusHtml = rec
      ? `<span class="progress-status-badge ${rec.actualEnd >= w.rangeEnd ? 'ps-on-track' : 'ps-behind'}">
           ${rec.actualEnd >= w.rangeEnd ? '✅ 完了' : `⚠️ ${rec.actualEnd - w.rangeStart + 1}/${plannedCount}個完了`}
         </span>`
      : '';
    itemsHtml += `
      <div class="progress-item">
        <span class="progress-plan-label">単語 ${w.rangeStart}〜${w.rangeEnd}（予定 ${plannedCount}個）</span>
        ${buildProgControlHtml(
          w.rangeStart, w.rangeEnd, recordedVal, 'word', statusHtml,
          `data-entry-id="${chunkKey}" data-origin-entry-id="${w.entryId}" data-type="word" data-planned-start="${w.rangeStart}" data-planned-end="${w.rangeEnd}" data-date="${dateStr}"`
        )}
      </div>`;
  });

  // ── 新規：参考書チャンク ─────────────────────────────────────
  dayBooks.forEach(b => {
    const planId = b.planId;
    // チャンクを一意に識別するキー: planId + チャンク本来の日付 + 開始ページ
    // 繰り越し分は originalDate、通常分は dateStr（= b.date）を使う
    const chunkOriginalDate = b.carriedForward ? (b.originalDate || b.date) : b.date;
    const chunkEntryId = `${planId}_${chunkOriginalDate}_${b.rangeStart}`;
    const rec = existingRecords.find(p => p.entryId === chunkEntryId && p.type === 'book');
    const recordedVal = rec ? rec.actualEnd : '';
    const plannedCount = b.rangeEnd - b.rangeStart + 1;
    // STEP 8: 未完了繰越バッジを統一形式で表示
    const cfNote = b.carriedForward ? buildCarryBadgeHtml(b.originalDate) : '';
    const statusHtml = rec
      ? `<span class="progress-status-badge ${rec.actualEnd >= b.rangeEnd ? 'ps-on-track' : 'ps-behind'}">
           ${rec.actualEnd >= b.rangeEnd ? '✅ 完了' : `⚠️ ${rec.actualEnd - b.rangeStart + 1}/${plannedCount}ページ完了`}
         </span>`
      : '';
    itemsHtml += `
      <div class="progress-item">
        <span class="progress-plan-label">${escapeHtml(b.bookName)} ${b.rangeStart}〜${b.rangeEnd}（予定 ${plannedCount}ページ）${cfNote}</span>
        ${buildProgControlHtml(
          b.rangeStart, b.rangeEnd, recordedVal, 'book', statusHtml,
          `data-entry-id="${chunkEntryId}" data-plan-id="${planId}" data-type="book" data-planned-start="${b.rangeStart}" data-planned-end="${b.rangeEnd}" data-date="${dateStr}" data-book-name="${escapeHtml(b.bookName)}"`
        )}
      </div>`;
  });

  // ── 復習：単語 ──────────────────────────────────────────────
  // 未完了の復習タスクのみ入力欄を表示（チェック済みはスキップ）
  const pendingWordReviews = dayWordReviews.filter(r => !r.done);
  if (pendingWordReviews.length > 0) {
    itemsHtml += `<div class="progress-review-divider">🔁 復習タスク（単語）の進捗</div>`;
    pendingWordReviews.forEach(r => {
      const tier = getIntervalTier(r.interval);
      const ts   = getIntervalTierStyle(r.interval);
      const rec  = existingRecords.find(p => p.reviewKey === r.key && p.type === 'word-review');
      const recordedVal  = rec ? rec.actualEnd : '';
      const plannedCount = r.rangeEnd - r.rangeStart + 1;
      const statusHtml = rec
        ? `<span class="progress-status-badge ${rec.actualEnd >= r.rangeEnd ? 'ps-on-track' : 'ps-behind'}">
             ${rec.actualEnd >= r.rangeEnd ? '✅ 完了' : `⚠️ ${rec.actualEnd - r.rangeStart + 1}/${plannedCount}個`}
           </span>`
        : '';
      // STEP 8: 進捗入力欄の復習バッジも統一形式で表示
      const reviewBadgeWord = buildReviewBadgeHtml(r.interval, r.delayedDays);
      itemsHtml += `
        <div class="progress-item review-item t${tier}">
          <span class="progress-plan-label">
            ${reviewBadgeWord}
            単語 ${r.rangeStart}〜${r.rangeEnd}（${plannedCount}個）
          </span>
          ${buildProgControlHtml(
            r.rangeStart, r.rangeEnd, recordedVal, 'word-review', statusHtml,
            `data-review-key="${r.key}" data-type="word-review" data-planned-start="${r.rangeStart}" data-planned-end="${r.rangeEnd}" data-date="${dateStr}"`
          )}
        </div>`;
    });
  }

  // ── 復習：参考書 ─────────────────────────────────────────────
  const pendingBookReviews = dayBookReviews.filter(r => !r.done);
  if (pendingBookReviews.length > 0) {
    itemsHtml += `<div class="progress-review-divider">📚 復習タスク（参考書）の進捗</div>`;
    pendingBookReviews.forEach(r => {
      const tier = getIntervalTier(r.interval);
      const ts   = getIntervalTierStyle(r.interval);
      const rec  = existingRecords.find(p => p.reviewKey === r.key && p.type === 'book-review');
      const recordedVal  = rec ? rec.actualEnd : '';
      const plannedCount = r.rangeEnd - r.rangeStart + 1;
      const statusHtml = rec
        ? `<span class="progress-status-badge ${rec.actualEnd >= r.rangeEnd ? 'ps-on-track' : 'ps-behind'}">
             ${rec.actualEnd >= r.rangeEnd ? '✅ 完了' : `⚠️ ${rec.actualEnd - r.rangeStart + 1}/${plannedCount}ページ`}
           </span>`
        : '';
      // STEP 8: 進捗入力欄の参考書復習バッジも統一形式で表示
      const reviewBadgeBook = buildReviewBadgeHtml(r.interval, r.delayedDays);
      itemsHtml += `
        <div class="progress-item review-item t${tier}">
          <span class="progress-plan-label">
            ${reviewBadgeBook}
            ${escapeHtml(r.bookName)} ${r.rangeStart}〜${r.rangeEnd}（${plannedCount}ページ）
          </span>
          ${buildProgControlHtml(
            r.rangeStart, r.rangeEnd, recordedVal, 'book-review', statusHtml,
            `data-review-key="${r.key}" data-type="book-review" data-planned-start="${r.rangeStart}" data-planned-end="${r.rangeEnd}" data-date="${dateStr}" data-book-name="${escapeHtml(r.bookName)}"`
          )}
        </div>`;
    });
  }

  // 新規・復習ともにタスクがなければ null を返す
  if (!itemsHtml) return null;

  const savedLabel = hasAnyRecord
    ? `<span class="progress-recorded-badge">✓ 記録済み</span>`
    : '';

  return `
    <div class="progress-section" id="progress-section-${baseId}">
      <div class="progress-section-title">
        📝 今日の進捗を入力
        ${savedLabel}
      </div>
      ${itemsHtml}
      <div class="ahead-banner" id="ahead-banner-${baseId}" style="display:none;">
        <span class="ahead-text" id="ahead-text-${baseId}"></span>
        <button class="btn-primary" style="font-size:.8rem; padding:7px 12px;"
                onclick="handleProgressSave('${dateStr}', '${baseId}')">
          スケジュールを再調整する
        </button>
      </div>
      <div class="behind-note" id="behind-note-${baseId}" style="display:none;"></div>
      <div class="progress-save-row">
        <button class="btn-primary" style="font-size:.85rem;"
                onclick="handleProgressSave('${dateStr}', '${baseId}')">
          📌 進捗を記録してスケジュールを調整
        </button>
        ${hasAnyRecord ? `<button class="btn-ghost" style="font-size:.8rem;"
                onclick="handleProgressClear('${dateStr}')">記録をリセット</button>` : ''}
      </div>
    </div>`;
}

/**
 * 進捗入力フィールドの値変化にリアルタイムで反応するイベントをアタッチ
 * @param {string} [baseId] - buildProgressInputSection に渡したものと同じベースID
 */
/**
 * 進捗入力コントロール（ボタン＋ステッパー）のインタラクションをセットアップ
 */
function initProgressControls(container, dateStr, baseId) {
  baseId = baseId || dateStr;

  container.querySelectorAll('.prog-control-ui').forEach(ui => {
    const hiddenInput    = ui.querySelector('.progress-num-input');
    if (!hiddenInput) return;

    const btnDone        = ui.querySelector('.prog-btn-done');
    const btnPartial     = ui.querySelector('.prog-btn-partial');
    const partialPanel   = ui.querySelector('.prog-partial-panel');
    const progDisplay    = ui.querySelector('.prog-display');
    const progDisplayInput = ui.querySelector('.prog-display-input');
    const barFill        = ui.querySelector('.prog-bar-fill');
    const countValEl     = ui.querySelector('.prog-count-val');
    const step1Label     = ui.querySelector('.prog-step1-label');
    const extraPanel     = ui.querySelector('.prog-extra-panel');

    const rangeStart   = parseInt(hiddenInput.dataset.plannedStart, 10);
    const rangeEnd     = parseInt(hiddenInput.dataset.plannedEnd,   10);
    const plannedCount = rangeEnd - rangeStart + 1;

    /* ── 表示を更新し、hidden input を更新してプレビューを起動 ── */
    function updateDisplay(val) {
      const clampedVal     = Math.max(rangeStart - 1, Math.min(rangeEnd + 50, val));
      const completedCount = Math.max(0, clampedVal - rangeStart + 1);
      const pct            = plannedCount > 0 ? Math.min(100, Math.round(completedCount / plannedCount * 100)) : 0;

      if (progDisplay)      progDisplay.textContent = clampedVal;
      if (progDisplayInput) progDisplayInput.value  = clampedVal;
      if (barFill)          barFill.style.width      = pct + '%';
      if (countValEl)       countValEl.textContent   = completedCount;

      hiddenInput.value = clampedVal;
      hiddenInput.dispatchEvent(new Event('input'));
    }

    /* ── ①ラベルの色をステップ状態に合わせて更新 ── */
    function updateStep1Label(mode) {
      if (!step1Label) return;
      step1Label.classList.toggle('step-done',    mode === 'done');
      step1Label.classList.toggle('step-partial', mode === 'partial');
    }

    /* ── ボタンのアクティブ状態を切り替える ── */
    function setActiveState(mode) {
      if (btnDone)      btnDone.classList.toggle('prog-btn-active',    mode === 'done');
      if (btnPartial)   btnPartial.classList.toggle('prog-btn-active', mode === 'partial');
      if (partialPanel) partialPanel.style.display = (mode === 'partial') ? 'block' : 'none';
      // ★ 「未完了」に切り替えたときは余剰パネルも閉じる
      if (extraPanel && mode !== 'done') extraPanel.style.display = 'none';
      updateStep1Label(mode);
    }

    /* ── 「✅ 完了」 ── */
    if (btnDone) {
      btnDone.addEventListener('click', () => {
        updateDisplay(rangeEnd);
        setActiveState('done');
        // ★ 余剰ページパネルを表示し、入力値を 0 にリセット
        if (extraPanel) {
          const extraInput = extraPanel.querySelector('.prog-extra-input');
          if (extraInput) extraInput.value = '0';
          extraPanel.style.display = 'block';
        }
      });
    }

    /* ── 余剰ページパネル ── */
    if (extraPanel) {
      // 「追加なし」→ パネルを閉じ、rangeEnd のまま確定
      const extraNoBtn = extraPanel.querySelector('.prog-extra-no-btn');
      if (extraNoBtn) {
        extraNoBtn.addEventListener('click', () => {
          extraPanel.style.display = 'none';
          // hiddenInput は既に rangeEnd なのでそのまま、プレビューだけ更新
          hiddenInput.dispatchEvent(new Event('input'));
        });
      }

      // ±ステッパー（余剰パネル専用。既存の .prog-step とクラス名が異なるため競合なし）
      extraPanel.querySelectorAll('.prog-extra-step').forEach(btn => {
        btn.addEventListener('click', () => {
          const extraInput = extraPanel.querySelector('.prog-extra-input');
          if (!extraInput) return;
          const delta   = parseInt(btn.dataset.delta, 10);
          const current = parseInt(extraInput.value, 10) || 0;
          extraInput.value = Math.max(0, current + delta);
        });
      });

      // 「✅ 記録」→ rangeEnd + 余剰ページ を hiddenInput に直接セット
      // ※ updateDisplay() のクランプ（+50上限）を迂回するため直接代入する
      const extraConfirmBtn = extraPanel.querySelector('.prog-extra-confirm-btn');
      if (extraConfirmBtn) {
        extraConfirmBtn.addEventListener('click', () => {
          const extraInput = extraPanel.querySelector('.prog-extra-input');
          const extraPages = Math.max(0, parseInt(extraInput?.value, 10) || 0);
          hiddenInput.value = rangeEnd + extraPages;
          hiddenInput.dispatchEvent(new Event('input')); // previewProgressAdjustment を起動
          extraPanel.style.display = 'none';
        });
      }
    }

    /* ── 「⚠️ 未完了」 ── */
    if (btnPartial) {
      btnPartial.addEventListener('click', () => {
        // 現在が「完了」または未入力なら、中間値を初期値にする
        const currentVal = parseInt(hiddenInput.value, 10);
        if (isNaN(currentVal) || currentVal >= rangeEnd) {
          const midVal = rangeStart - 1 + Math.max(1, Math.floor(plannedCount * 0.5));
          updateDisplay(Math.min(rangeEnd - 1, midVal));
        }
        setActiveState('partial');
        // パネルが開いたら入力フィールドにフォーカス
        if (progDisplayInput) {
          setTimeout(() => progDisplayInput.focus(), 50);
        }
      });
    }

    /* ── 直接入力フィールド ── */
    if (progDisplayInput) {
      progDisplayInput.addEventListener('input', () => {
        const val = parseInt(progDisplayInput.value, 10);
        if (!isNaN(val)) {
          const clampedVal = Math.max(rangeStart - 1, Math.min(rangeEnd + 50, val));
          const completedCount = Math.max(0, clampedVal - rangeStart + 1);
          const pct = plannedCount > 0 ? Math.min(100, Math.round(completedCount / plannedCount * 100)) : 0;
          if (barFill)    barFill.style.width   = pct + '%';
          if (countValEl) countValEl.textContent = completedCount;
          if (progDisplay) progDisplay.textContent = clampedVal;
          hiddenInput.value = clampedVal;
          hiddenInput.dispatchEvent(new Event('input'));
          // 完了範囲に達したら完了ボタンもアクティブに
          if (clampedVal >= rangeEnd) {
            setActiveState('done');
          }
        }
      });
      progDisplayInput.addEventListener('blur', () => {
        // ブラー時に範囲外の値をクランプして同期
        const val = parseInt(hiddenInput.value, 10);
        if (!isNaN(val)) progDisplayInput.value = val;
      });
      // Enterキーで入力確定
      progDisplayInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); progDisplayInput.blur(); }
      });
    }

  });
}

function attachProgressInputHandlers(container, dateStr, baseId) {
  baseId = baseId || dateStr;
  container.querySelectorAll('.progress-num-input').forEach(input => {
    input.addEventListener('input', () => previewProgressAdjustment(container, dateStr, baseId));
  });
  // 新UIのインタラクションもここで初期化
  initProgressControls(container, dateStr, baseId);
}

/**
 * 入力値を読みながら「進捗バナー」をリアルタイムプレビュー
 * @param {string} [baseId] - buildProgressInputSection に渡したものと同じベースID
 */
function previewProgressAdjustment(container, dateStr, baseId) {
  baseId = baseId || dateStr;
  let hasAhead = false, hasBehind = false;
  let aheadMessages = [], behindMessages = [];

  container.querySelectorAll('.progress-num-input').forEach(input => {
    const val = parseInt(input.value, 10);
    if (isNaN(val)) return;
    const plannedEnd   = parseInt(input.dataset.plannedEnd,   10);
    const plannedStart = parseInt(input.dataset.plannedStart, 10);
    const type         = input.dataset.type;

    // 復習タスクは「ページ/個数」のみ記録（繰り越し再調整は行わない）
    const isReview = type === 'word-review' || type === 'book-review';
    const unit = (type === 'word' || type === 'word-review') ? '個' : 'ページ';
    const prefix = isReview ? '復習 ' : '';
    const label = (type === 'word' || type === 'word-review')
      ? `${prefix}単語 ${plannedStart}〜${plannedEnd}`
      : `${prefix}${input.dataset.bookName || '参考書'} ${plannedStart}〜${plannedEnd}`;

    if (!isReview && val > plannedEnd) {
      // 新規タスクで予定より進んだ場合のみスケジュール再調整バナーを表示
      hasAhead = true;
      aheadMessages.push(`${label}: ${val - plannedEnd}${unit}多く進みました！`);
    } else if (val < plannedEnd && val >= plannedStart) {
      hasBehind = true;
      const diff = plannedEnd - val;
      if (isReview) {
        behindMessages.push(`${label}: ${diff}${unit}残っています`);
      } else {
        behindMessages.push(`${label}: ${diff}${unit}残っています → 残りのスケジュールに自動で分散します`);
      }
    }
  });

  const aheadBanner = container.querySelector(`#ahead-banner-${baseId}`);
  const aheadText = container.querySelector(`#ahead-text-${baseId}`);
  const behindNote = container.querySelector(`#behind-note-${baseId}`);

  if (aheadBanner && aheadText) {
    if (hasAhead) {
      aheadText.textContent = '🎉 予定より進んでいます！ ' + aheadMessages.join(' / ') + ' 記録するとスケジュールが更新されます。';
      aheadBanner.style.display = 'flex';
    } else {
      aheadBanner.style.display = 'none';
    }
  }
  if (behindNote) {
    if (hasBehind) {
      behindNote.innerHTML = '⚠️ ' + behindMessages.map(m => escapeHtml(m)).join('<br>');
      behindNote.style.display = 'block';
    } else {
      behindNote.style.display = 'none';
    }
  }
}

/**
 * 進捗を保存してスケジュールを再描画
 * @param {string} [baseId] - buildProgressInputSection に渡したものと同じベースID
 */
function handleProgressSave(dateStr, baseId) {
  baseId = baseId || dateStr;
  const container = document.getElementById(`progress-section-${baseId}`);
  if (!container) return;

  const inputs = container.querySelectorAll('.progress-num-input');
  let saved = 0;

  // 保存するレコードを収集（後で復習スケジュール表示に使う）
  const savedRecords = [];

  inputs.forEach(input => {
    const val = parseInt(input.value, 10);
    if (isNaN(val)) return;

    const type = input.dataset.type;
    const plannedStart = parseInt(input.dataset.plannedStart, 10);
    const plannedEnd   = parseInt(input.dataset.plannedEnd,   10);
    const bookName     = input.dataset.bookName || '';

    if (type === 'word-review' || type === 'book-review') {
      // ── 復習タスクの進捗記録（reviewKey で識別）──
      const reviewKey = input.dataset.reviewKey;
      dailyProgress = dailyProgress.filter(
        p => !(p.date === dateStr && p.reviewKey === reviewKey && p.type === type)
      );
      const record = {
        id: 'dp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        date: dateStr,
        reviewKey,
        type,
        plannedStart,
        plannedEnd,
        actualEnd: val,
        bookName
      };
      dailyProgress.push(record);
      savedRecords.push(record);
      saved++;
    } else {
      // ── 新規タスク（word / book）の進捗記録（entryId で識別）──
      const entryId = input.dataset.entryId;
      // word: entryId は composite key（entryId_chunkDate_rangeStart）、originEntryId は元の entry.id
      const originEntryId = input.dataset.originEntryId || undefined;
      // book タイプは planId（参考書プランID）も別途保持する
      // entryId は「planId_originalDate_rangeStart」の複合キーなので refEntries への紐付けに planId を使う
      const planId = input.dataset.planId || entryId;
      dailyProgress = dailyProgress.filter(
        p => !(p.date === dateStr && p.entryId === entryId && p.type === type)
      );
      const record = {
        id: 'dp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
        date: dateStr,
        entryId,
        originEntryId: type === 'word' ? originEntryId : undefined, // ★ word: 元の entry.id を別途保存
        planId: type === 'book' ? planId : undefined, // book のみ planId を保持
        type,
        plannedStart,
        plannedEnd,
        actualEnd: val,
        bookName
      };
      dailyProgress.push(record);
      savedRecords.push(record);
      saved++;
    }
  });

  if (saved === 0) {
    alert('進捗を入力してから保存してください。');
    return;
  }

  saveDailyProgress();
  // スケジュール全体を再描画（進捗に基づき再計算される）
  renderIntegratedSchedule();
  refreshAllSchedules();
  renderRefTodayCard();

  // スケジュールタブ内の進捗セクションに単語復習プレビューを注入
  const wordRecordsForPreview = savedRecords.filter(r => r.type === 'word');
  if (wordRecordsForPreview.length > 0) {
    // renderIntegratedSchedule() 後に再生成された progress-section を探す
    // スケジュールタブでは baseId === dateStr
    const progressSectionEl = document.getElementById(`progress-section-${dateStr}`);
    if (progressSectionEl) {
      // 既存のプレビューがあれば除去（重複防止）
      const existing = progressSectionEl.querySelector(`#word-review-preview-${dateStr}`);
      if (existing) existing.remove();
      const previewHtml = buildWordReviewPreviewHtml(dateStr, wordRecordsForPreview);
      if (previewHtml) {
        const previewEl = document.createElement('div');
        previewEl.id = `word-review-preview-${dateStr}`;
        previewEl.innerHTML = previewHtml;
        progressSectionEl.appendChild(previewEl);
      }
    }
  }
}

/**
 * 単語の進捗記録から「復習スケジュールプレビュー」HTMLを生成するヘルパー。
 * スケジュールタブ内インジェクションから呼ばれる。
 * @param {string} dateStr     - 進捗を記録した日付 (YYYY-MM-DD)
 * @param {Array}  wordRecords - type === 'word' の savedRecords 配列
 * @returns {string} HTML文字列（対象なしの場合は空文字）
 */
function buildWordReviewPreviewHtml(dateStr, wordRecords) {
  if (!wordRecords || wordRecords.length === 0) return '';

  let wordsHtml = '';
  wordRecords.forEach(rec => {
    const entry = entries.find(e => e.id === rec.entryId);
    if (!entry) return;

    const actualEnd  = rec.actualEnd;
    const diff       = actualEnd - rec.plannedEnd;

    let diffHtml = '';
    if (diff > 0) {
      diffHtml = `<div class="progressed-overshot">🎉 予定より ${diff}個多く進みました！ 余分に進んだ分も復習対象に追加されました。</div>`;
    } else if (diff < 0) {
      diffHtml = `<div class="progressed-undershot">⚠️ ${Math.abs(diff)}個残りました。残りは以降のスケジュールに自動分散されました。</div>`;
    }

    const slotsHtml = DEFAULT_INTERVALS.map(n => {
      const d = parseISO(formatISO(addDays(parseISO(dateStr), n)));
      const wdLabel  = ['日','月','火','水','木','金','土'][d.getDay()];
      const dispDate = `${d.getMonth()+1}/${d.getDate()}（${wdLabel}）`;
      const tier      = getIntervalTier(n);
      const tierLabel = ['', 'Lv.1 初期', 'Lv.2 定着', 'Lv.3 強化', 'Lv.4 仕上げ'][tier];
      return `<span class="progressed-review-slot slot-t${tier}">
        <span class="slot-date">${dispDate}</span>
        <span class="slot-lv">${n}日後 ${tierLabel}</span>
      </span>`;
    }).join('');

    wordsHtml += `
      <div class="progressed-review-book">
        <div class="progressed-review-book-name">
          📖 単語 ${rec.plannedStart}〜${actualEnd}
          <span class="range-badge">${rec.plannedStart}〜${actualEnd}番</span>
        </div>
        ${diffHtml}
        <div style="font-size:.8rem;color:var(--ink-soft);margin-bottom:6px;font-weight:600;">📅 この範囲の復習予定日：</div>
        <div class="progressed-review-slots">${slotsHtml}</div>
      </div>`;
  });

  if (!wordsHtml) return '';
  return `<div class="progressed-review-section" style="margin-top:16px;">
    <div class="progressed-review-title">📖 単語の進捗を記録 — 復習スケジュールが追加されました</div>
    ${wordsHtml}
  </div>`;
}

/**
 * 今日の進捗記録をクリアしてスケジュールを元に戻す
 */
function handleProgressClear(dateStr) {
  if (!confirm(`${dateStr} の進捗記録をリセットしますか？\nスケジュールが元の計画に戻ります。`)) return;
  dailyProgress = dailyProgress.filter(p => p.date !== dateStr);
  saveDailyProgress();
  renderIntegratedSchedule();
  refreshAllSchedules();
  renderRefTodayCard();
}

function renderTodayNew(){
  const box = document.getElementById('todayNewBox');
  const todayIso = todayISO();
  const allChunks = entries.flatMap(computeChunksForEntry);
  const todayChunks = allChunks.filter(c => c.date === todayIso);
  if(todayChunks.length === 0){
    box.innerHTML = `<div class="empty-mini">今日の新規範囲はありません。</div>`;
  }else{
    box.innerHTML = todayChunks.map(c => `<span class="today-new-tag">${c.rangeStart}〜${c.rangeEnd}</span>`).join('');
  }
}

/**
 * 参考書タブの「今日やること」カードを描画する。
 * - 今日の新規参考書チャンク（繰り越し含む）を緑タグで表示
 * - 今日の参考書復習をチェックボックス付きで表示
 */
function renderRefTodayCard() {
  const newBox    = document.getElementById('refTodayNewBox');
  const reviewList = document.getElementById('refTodayReviewList');
  if (!newBox || !reviewList) return;

  const todayStr = todayISO();
  const { refChunks, refReviews } = buildScheduleData();

  // ── 今日の新規範囲 ──────────────────────────────────────────
  const todayChunks = refChunks.filter(c => c.date === todayStr);
  if (todayChunks.length === 0) {
    newBox.innerHTML = '<div class="empty-mini">今日の参考書範囲はありません。</div>';
  } else {
    newBox.innerHTML = todayChunks.map(c => {
      // STEP 8: 未完了繰越バッジを統一形式で表示
      const cfBadge = c.carriedForward ? buildCarryBadgeHtml(c.originalDate) : '';
      return `<span class="today-ref-tag">${escapeHtml(c.bookName)}<br><span style="font-weight:400;font-size:.82em;">p.${c.rangeStart}〜${c.rangeEnd}</span>${cfBadge ? '<br>' + cfBadge : ''}</span>`;
    }).join('');
  }

  // ── 今日の復習 ──────────────────────────────────────────────
  const todayReviews = refReviews.filter(r => r.date === todayStr);
  if (todayReviews.length === 0) {
    reviewList.innerHTML = '<div class="empty-mini">今日の参考書復習はありません。</div>';
  } else {
    // 未完了を先頭、完了済みを後ろに並べる
    const sorted = [...todayReviews].sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0));
    const itemsHtml = sorted.map(r => {
      const ts = getIntervalTierStyle(r.interval);
      // STEP 8: 復習バッジを統一形式で表示（🔁 復習 Lv.X [N日後] + 🔄 [遅れN日]）
      const reviewBadge = buildReviewBadgeHtml(r.interval, r.delayedDays);
      return `<div class="ref-review-item${r.done ? ' is-done' : ''}">
        <div class="ref-book-info">
          <span class="ref-book-title">${escapeHtml(r.bookName)}</span>
          <span class="ref-book-range">p.${r.rangeStart}〜${r.rangeEnd}</span>
        </div>
        <label class="tag tag-ref-review tag-review-t${getIntervalTier(r.interval)} review-check-label${r.done ? ' is-done' : ''}"
               style="cursor:pointer; padding:6px 12px; display:inline-flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <input type="checkbox" class="review-check" data-key="${r.key}" ${r.done ? 'checked' : ''}>
          <span class="stamp">◎</span>
          ${reviewBadge}
        </label>
      </div>`;
    }).join('');
    reviewList.innerHTML = `<div class="due-list" style="gap:10px;">${itemsHtml}</div>`;
    attachReviewCheckHandlers(reviewList);
  }

}

function renderAll(){
  renderEntryList();
  renderSchedule();
  renderTodayNew();
}

async function handleAdd(){
  const startNum = Number(document.getElementById('startNum').value);
  const endNum = Number(document.getElementById('endNum').value);
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value; // 追加
  const weekdays = getCheckedValues('weekdayRow');
  const reviewWeekdays = getCheckedValues('reviewWeekdayRow'); // ★復習曜日を取得
  const intervals = getCheckedValues('intervalRow');
  const errorEl = document.getElementById('errorMsg');
  const planMode = document.querySelector('input[name="planMode"]:checked').value;
  const amountPerDay = Number(document.getElementById('amountPerDay').value);
  errorEl.textContent = '';

  if(!startNum || !endNum || endNum < startNum){
    errorEl.textContent = '開始番号・終了番号を正しく入力してください（終了番号は開始番号以上）。'; return;
  }
  if(!startDate){ errorEl.textContent = '開始日を選択してください。'; return; }
  
  // 終了日のバリデーションを追加
  if(planMode === 'byRange') {
    if(!endDate){ errorEl.textContent = '終了日を選択してください。'; return; }
    if(new Date(endDate) < new Date(startDate)){ errorEl.textContent = '終了日は開始日以降の日付にしてください。'; return; }
  }

  if(weekdays.length === 0){ errorEl.textContent = '学習する曜日を1つ以上選んでください。'; return; }
  if(intervals.length === 0){ errorEl.textContent = '復習のタイミングを1つ以上選んでください。'; return; }
  if(planMode === 'byAmount' && (!amountPerDay || amountPerDay <= 0)){
    errorEl.textContent = '1日あたりの単語数を正しく入力してください。'; return;
  }

  // entryオブジェクトに endDate と reviewWeekdays を追加
  entries.push({ id: 'e' + Date.now(), startNum, endNum, startDate, endDate, weekdays, reviewWeekdays, intervals, planMode, amountPerDay });
  await saveEntries();
  renderAll();
}

async function handleReset(){
  if(!confirm('登録した範囲をすべて削除します。よろしいですか？')) return;
  entries = [];
  await saveEntries();
  renderAll();
}

/* ---------- leech words (shared) ---------- */

async function loadLeech(){
  try{
    const raw = localStorage.getItem(LEECH_KEY);
    leechWords = raw ? JSON.parse(raw) : [];
  }catch(e){ leechWords = []; }
}
async function saveLeech(){
  try{
    localStorage.setItem(LEECH_KEY, JSON.stringify(leechWords));
  }catch(e){ console.error('Storage error:', e); }
}

function nextDateForStep(step){
  const idx = Math.min(step, LEECH_INTERVALS.length - 1);
  return formatISO(addDays(new Date(), LEECH_INTERVALS[idx]));
}

async function handleLeechAdd(){
  const wordEl = document.getElementById('leechWord');
  const meaningEl = document.getElementById('leechMeaning');
  const errorEl = document.getElementById('leechErrorMsg');
  errorEl.textContent = '';
  const word = wordEl.value.trim();
  const meaning = meaningEl.value.trim();
  if(!word){ errorEl.textContent = '単語を入力してください。'; return; }
  leechWords.push({
    id: 'w' + Date.now(), word, meaning, stepIndex: 0,
    nextReviewDate: nextDateForStep(0), missCount: 0, status: 'active'
  });
  await saveLeech();
  renderLeech();
  wordEl.value = ''; meaningEl.value = ''; wordEl.focus();
}

async function handleLeechCorrect(id){
  const entry = leechWords.find(w => w.id === id);
  if(!entry) return;
  const newStep = entry.stepIndex + 1;
  if(newStep >= LEECH_INTERVALS.length){
    entry.status = 'graduated';
    entry.gradDate = todayISO();
  }else{
    entry.stepIndex = newStep;
    entry.nextReviewDate = nextDateForStep(newStep);
  }
  await saveLeech();
  renderLeech();
}

async function handleLeechWrong(id){
  const entry = leechWords.find(w => w.id === id);
  if(!entry) return;
  entry.missCount = (entry.missCount || 0) + 1;
  entry.stepIndex = 0;
  entry.nextReviewDate = nextDateForStep(0);
  await saveLeech();
  renderLeech();
}

async function handleLeechDelete(id){
  leechWords = leechWords.filter(w => w.id !== id);
  await saveLeech();
  renderLeech();
}

function renderLeech(){
  const todayIso = todayISO();
  const active = leechWords.filter(w => w.status === 'active');
  const graduated = leechWords.filter(w => w.status === 'graduated');
  const due = active.filter(w => w.nextReviewDate <= todayIso)
                     .sort((a,b) => a.nextReviewDate.localeCompare(b.nextReviewDate));

  const dueList = document.getElementById('dueList');
  if(due.length === 0){
    dueList.innerHTML = `<div class="empty-mini">今日レビューする単語はありません。</div>`;
  }else{
    dueList.innerHTML = due.map(w => {
      const overdue = w.nextReviewDate < todayIso;
      const warn = w.missCount >= LEECH_WARN_THRESHOLD
        ? `<span class="badge-warn">要注意：語源・対義語など別の覚え方を</span>` : '';
      return `
        <div class="due-item" data-id="${w.id}">
          <div class="word-row">
            <div><span class="word">${w.word}</span>${overdue ? '<span class="overdue">期限超過</span>' : ''}${warn}</div>
            <button class="reveal-btn" data-action="reveal" data-id="${w.id}">意味を確認</button>
          </div>
          <div class="meaning-text" data-role="meaning" data-id="${w.id}">${w.meaning || '（メモ未登録：口頭で確認）'}</div>
          <div class="word-actions" data-role="actions" data-id="${w.id}">
            <button class="btn-correct" data-action="correct" data-id="${w.id}">できた</button>
            <button class="btn-wrong" data-action="wrong" data-id="${w.id}">もう一度</button>
          </div>
        </div>`;
    }).join('');

    dueList.querySelectorAll('[data-action="reveal"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        dueList.querySelector(`[data-role="meaning"][data-id="${id}"]`).classList.add('shown');
        dueList.querySelector(`[data-role="actions"][data-id="${id}"]`).classList.add('shown');
      });
    });
    dueList.querySelectorAll('[data-action="correct"]').forEach(btn => {
      btn.addEventListener('click', () => handleLeechCorrect(btn.dataset.id));
    });
    dueList.querySelectorAll('[data-action="wrong"]').forEach(btn => {
      btn.addEventListener('click', () => handleLeechWrong(btn.dataset.id));
    });
  }

  const activeSorted = active.slice().sort((a,b) => a.nextReviewDate.localeCompare(b.nextReviewDate));
  document.getElementById('activeSummary').textContent = `登録中の苦手単語（${activeSorted.length}）`;
  const activeTable = document.getElementById('activeTable');
  if(activeSorted.length === 0){
    activeTable.innerHTML = `<tr><td class="empty-mini">まだ登録されていません。</td></tr>`;
  }else{
    activeTable.innerHTML = `
      <tr><th>単語</th><th>次回レビュー</th><th>ミス回数</th><th></th></tr>
      ${activeSorted.map(w => `
      <tr>
       <td>
        ${w.word}
        <button onclick="speakWord('${w.word}')" style="background:none; border:none; cursor:pointer; font-size:1rem; margin-left:6px;">🔊</button>
        ${w.missCount >= LEECH_WARN_THRESHOLD ? '<span class="badge-warn">要注意</span>' : ''}
       </td>
       <td>${w.nextReviewDate}</td>
       <td>${w.missCount}</td>
       <td><button class="mini-del" data-id="${w.id}">削除</button></td>
      </tr>`).join('')}
    `;
    activeTable.querySelectorAll('.mini-del').forEach(btn => {
      btn.addEventListener('click', () => handleLeechDelete(btn.dataset.id));
    });
  }

  document.getElementById('graduatedSummary').textContent = `卒業した単語（${graduated.length}）`;
  const gradTable = document.getElementById('graduatedTable');
  if(graduated.length === 0){
    gradTable.innerHTML = `<tr><td class="empty-mini">まだありません。</td></tr>`;
  }else{
    gradTable.innerHTML = `
      <tr><th>単語</th><th>卒業日</th><th></th></tr>
      ${graduated.map(w => `
        <tr>
          <td>${w.word}</td>
          <td>${w.gradDate || '-'}</td>
          <td><button class="mini-del" data-id="${w.id}">削除</button></td>
        </tr>`).join('')}
    `;
    gradTable.querySelectorAll('.mini-del').forEach(btn => {
      btn.addEventListener('click', () => handleLeechDelete(btn.dataset.id));
    });
  }

}

/* ---------- 成績・弱点分析 ---------- */
function escapeHtml(str){
  return String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}

async function loadScores(){
  try{
    const raw = localStorage.getItem(SCORE_KEY);
    scoreRecords = raw ? JSON.parse(raw) : [];
  }catch(e){ scoreRecords = []; }
}
async function saveScores(){
  try{
    localStorage.setItem(SCORE_KEY, JSON.stringify(scoreRecords));
  }catch(e){ console.error('Storage error:', e); }
}

function renderScoreList(){
  const listEl = document.getElementById('scoreEntryList');
  if(!listEl) return;
  if(scoreRecords.length === 0){
    listEl.innerHTML = '<div class="empty-mini">まだ成績データが登録されていません。</div>';
  } else {
    const sorted = [...scoreRecords].sort((a,b) => (b.date||'').localeCompare(a.date||''));
    listEl.innerHTML = sorted.map(r => {
      const pct = r.total ? Math.round((r.score / r.total) * 100) : 0;
      const examBadge = r.examType
        ? `<span class="exam-type-badge">📋 ${escapeHtml(r.examType)}</span> `
        : '';
      const devBadge = (r.deviation != null && r.deviation !== '')
        ? `<span class="hensachi-badge"><span class="hb-label">偏差値</span>${escapeHtml(String(r.deviation))}</span> `
        : '';
      return `<div class="score-entry-item">
        <div style="flex:1; min-width:0;">
          <div style="display:flex; flex-wrap:wrap; gap:4px; align-items:center; margin-bottom:4px;">
            ${examBadge}${devBadge}
          </div>
          <span class="rng">${escapeHtml(r.subject || '教科未設定')}${r.category ? ' / ' + escapeHtml(r.category) : ''}</span>
          <div class="meta">${escapeHtml(r.date || '')} ・ ${r.score}/${r.total}点（${pct}%）${r.note ? ' ・ ' + escapeHtml(r.note) : ''}</div>
        </div>
        <button class="del-btn" onclick="handleScoreDelete('${r.id}')">削除</button>
      </div>`;
    }).join('');
  }
  renderScoreChart();
}

// 試験種別ドロップダウンの変更処理
function handleExamTypeChange(selectEl) {
  const customInput = document.getElementById('scoreExamTypeCustom');
  if (selectEl.value === 'custom') {
    customInput.style.display = 'block';
    customInput.focus();
  } else {
    customInput.style.display = 'none';
  }
}

// 現在選択されている試験種別名を返す
function getSelectedExamType() {
  const sel = document.getElementById('scoreExamType');
  if (!sel) return '';
  if (sel.value === 'custom') {
    return document.getElementById('scoreExamTypeCustom').value.trim();
  }
  return sel.value;
}

async function handleScoreAdd(){
  const subjectEl = document.getElementById('scoreSubject');
  const categoryEl = document.getElementById('scoreCategory');
  const valueEl = document.getElementById('scoreValue');
  const totalEl = document.getElementById('scoreTotal');
  const deviationEl = document.getElementById('scoreDeviation');
  const dateEl = document.getElementById('scoreDate');
  const noteEl = document.getElementById('scoreNote');
  const errorEl = document.getElementById('scoreErrorMsg');
  errorEl.textContent = '';

  const subject = subjectEl.value.trim();
  const score = Number(valueEl.value);
  const total = Number(totalEl.value) || 100;
  const examType = getSelectedExamType();
  const deviationRaw = deviationEl.value.trim();
  const deviation = deviationRaw !== '' ? Number(deviationRaw) : null;

  if(!subject){ errorEl.textContent = '教科を入力してください。'; return; }
  if(valueEl.value === '' || isNaN(score) || score < 0){ errorEl.textContent = '得点を正しく入力してください。'; return; }
  if(total <= 0){ errorEl.textContent = '満点は1以上で入力してください。'; return; }
  if(deviation !== null && (isNaN(deviation) || deviation < 0 || deviation > 100)){
    errorEl.textContent = '偏差値は0〜100の数値で入力してください（省略可）。'; return;
  }

  scoreRecords.push({
    id: 's' + Date.now(),
    subject,
    category: categoryEl.value.trim(),
    examType: examType || '',
    score, total,
    deviation,
    note: noteEl.value.trim(),
    date: dateEl.value || todayISO()
  });
  await saveScores();
  renderScoreList();

  // 入力欄をリセット（試験種別・教科・偏差値等）
  document.getElementById('scoreExamType').value = '';
  document.getElementById('scoreExamTypeCustom').style.display = 'none';
  document.getElementById('scoreExamTypeCustom').value = '';
  subjectEl.value = ''; categoryEl.value = ''; valueEl.value = '';
  totalEl.value = '100'; deviationEl.value = ''; noteEl.value = '';
  dateEl.value = todayISO();
  subjectEl.focus();
}

async function handleScoreDelete(id){
  scoreRecords = scoreRecords.filter(r => r.id !== id);
  await saveScores();
  renderScoreList();
}

function renderScoreChart(){
  const wrap = document.getElementById('scoreChartWrap');
  if(!wrap) return;
  if(typeof Chart === 'undefined' || scoreRecords.length === 0){ wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';

  /* ── ① 教科別 平均正答率チャート ── */
  const bySubject = {};
  scoreRecords.forEach(r => {
    const pct = r.total ? (r.score / r.total) * 100 : 0;
    if(!bySubject[r.subject]) bySubject[r.subject] = [];
    bySubject[r.subject].push(pct);
  });
  const labels = Object.keys(bySubject);
  const data = labels.map(k => Math.round(bySubject[k].reduce((a,b) => a+b, 0) / bySubject[k].length));

  const ctx = document.getElementById('scoreChart');
  if(scoreChartInstance) scoreChartInstance.destroy();
  scoreChartInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels, datasets: [{ label: '平均正答率(%)', data, backgroundColor: COLORS.gold }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: { min:0, max:100, grid:{ color: COLORS.grid } },
        x: { grid:{ display:false }, ticks:{ maxRotation:30, font:{ size:11 } } }
      },
      plugins: { legend:{ display:false } }
    }
  });

  /* ── ② 偏差値推移チャート（偏差値データがある場合のみ表示） ── */
  const devBox = document.getElementById('deviationChartBox');
  const devWithData = scoreRecords
    .filter(r => r.deviation != null && r.deviation !== '' && !isNaN(Number(r.deviation)))
    .sort((a,b) => (a.date||'').localeCompare(b.date||''))
    .slice(-10); // 直近10件

  if (!devBox) return;

  if (devWithData.length < 1) {
    devBox.style.display = 'none';
    if (deviationChartInstance) { deviationChartInstance.destroy(); deviationChartInstance = null; }
    return;
  }
  devBox.style.display = 'block';

  const devLabels = devWithData.map(r => {
    const subj = (r.subject || '').slice(0, 4);
    const exam = r.examType ? r.examType.replace(/模試|テスト|本番/g, '').slice(0,5) : '';
    return exam ? `${subj}\n${exam}` : subj;
  });
  const devData = devWithData.map(r => Number(r.deviation));

  // 偏差値帯の色分け
  const devColors = devData.map(v =>
    v >= 65 ? '#065f46' : v >= 55 ? COLORS.gold : v >= 45 ? COLORS.ink : COLORS.red
  );

  const devCtx = document.getElementById('deviationChart');
  if(deviationChartInstance) deviationChartInstance.destroy();
  deviationChartInstance = new Chart(devCtx, {
    type: 'bar',
    data: {
      labels: devLabels,
      datasets: [{
        label: '偏差値',
        data: devData,
        backgroundColor: devColors,
        borderRadius: 4,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: {
          min: Math.max(0, Math.min(...devData) - 10),
          max: Math.min(100, Math.max(...devData) + 10),
          grid: { color: COLORS.grid },
          ticks: { font: { size: 11 } }
        },
        x: { grid:{ display:false }, ticks:{ maxRotation:35, font:{ size:10 } } }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx2 => {
              const r = devWithData[ctx2.dataIndex];
              const exam = r.examType ? ` (${r.examType})` : '';
              return `偏差値 ${ctx2.raw}${exam}`;
            }
          }
        },
        annotation: {
          annotations: {
            line50: {
              type: 'line', yMin: 50, yMax: 50,
              borderColor: 'rgba(180,180,180,0.6)', borderWidth: 1, borderDash: [4,4],
            }
          }
        }
      }
    }
  });
}

// [ai-features.html] parseJsonFromText / fileToGenerativePart / handleScoreImageFile /
//                    runWeaknessAnalysis / renderAnalysisResult → ai-features.html に移動

/* ---------- Test Mode Logic ---------- */
let testQueue = [];
let currentTestIdx = 0;
let testSessionResults = [];

document.getElementById('startTestBtn').addEventListener('click', () => {
  const mode = document.getElementById('testMode').value;
  // active状態の単語のみを対象にする
  const activeWords = leechWords.filter(w => w.status === 'active');
  
  if(activeWords.length === 0) {
    alert('現在、テストできる単語が登録されていません。');
    return;
  }

  // 絞り込みロジック
  if(mode === 'all') {
    testQueue = [...activeWords];
  } else if(mode === 'warn') {
    testQueue = activeWords.filter(w => w.missCount >= LEECH_WARN_THRESHOLD);
    if(testQueue.length === 0) { alert('現在、要注意の単語はありません。'); return; }
  } else if(mode === 'random10') {
    // 配列をシャッフルして最大10件取得
    testQueue = [...activeWords].sort(() => 0.5 - Math.random()).slice(0, 10);
  }
  else if(mode === 'miss1') {
    testQueue = activeWords.filter(w => w.missCount === 1);
    if(testQueue.length === 0) { alert('現在、ミス1回の単語はありません。'); return; }
  }

  // テストの初期化
  currentTestIdx = 0;
  testSessionResults = [];
  document.getElementById('testArea').style.display = 'block';
  document.getElementById('resultArea').style.display = 'none';
  document.getElementById('testModal').classList.add('active');
  
  showTestWord();
});

function showTestWord() {
  if(currentTestIdx >= testQueue.length) {
    finishTest();
    return;
  }
  const wordData = testQueue[currentTestIdx];
  document.getElementById('testProgress').textContent = `問題 ${currentTestIdx + 1} / ${testQueue.length}`;
  document.getElementById('testWordDisplay').textContent = wordData.word;
  document.getElementById('testMeaningDisplay').textContent = wordData.meaning || '（メモ未登録：口頭で確認）';
  
  // 意味とボタンを隠し、「意味を確認」ボタンを表示
  document.getElementById('testMeaningDisplay').classList.remove('shown');
  document.getElementById('testActions').classList.remove('shown');
  document.getElementById('testRevealBtn').style.display = 'block';
}

document.getElementById('testRevealBtn').addEventListener('click', () => {
  document.getElementById('testRevealBtn').style.display = 'none';
  document.getElementById('testMeaningDisplay').classList.add('shown');
  document.getElementById('testActions').classList.add('shown');
});

document.getElementById('testCorrectBtn').addEventListener('click', async () => {
  const wordData = testQueue[currentTestIdx];
  testSessionResults.push({ word: wordData.word, correct: true });
  // 既存のスケジュール更新処理を呼び出す
  await handleLeechCorrect(wordData.id);
  currentTestIdx++;
  showTestWord();
});

document.getElementById('testWrongBtn').addEventListener('click', async () => {
  const wordData = testQueue[currentTestIdx];
  testSessionResults.push({ word: wordData.word, correct: false });
  // 既存のスケジュール更新処理を呼び出す
  await handleLeechWrong(wordData.id);
  currentTestIdx++;
  showTestWord();
});

function finishTest() {
  document.getElementById('testArea').style.display = 'none';
  const resultArea = document.getElementById('resultArea');
  resultArea.style.display = 'block';
  
  const correctCount = testSessionResults.filter(r => r.correct).length;
  const rate = Math.round((correctCount / testQueue.length) * 100);
  document.getElementById('resultScore').textContent = `正答率: ${correctCount} / ${testQueue.length} (${rate}%)`;
  
  const listHtml = testSessionResults.map(r => `
    <div class="result-item">
      <span style="font-family:'IBM Plex Mono', monospace; font-weight:700;">${r.word}</span>
      <span style="color:${r.correct ? 'var(--success)' : 'var(--margin-red)'}; font-weight:700;">
        ${r.correct ? '〇 できた' : '✖ もう一度'}
      </span>
    </div>
  `).join('');
  
  document.getElementById('resultList').innerHTML = listHtml;
}

/* ---------- TTS (読み上げ機能) ---------- */
function speakWord(text) {
  window.speechSynthesis.cancel(); // 連続読み上げを防ぐ
  const uttr = new SpeechSynthesisUtterance(text);
  uttr.lang = 'en-US'; // 英語の読み上げ設定
  uttr.rate = 0.9;     // 少しだけゆっくりにする（聞き取りやすく）
  window.speechSynthesis.speak(uttr);
}

// モーダルを閉じる処理
document.getElementById('closeTestBtn').addEventListener('click', () => {
  document.getElementById('testModal').classList.remove('active');
  // テスト結果によるスケジュールの変化を画面に反映
  renderLeech();
});

function showTab(tabName) {
  // タブコンテンツの表示・非表示を切り替え
  document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
  document.getElementById('tab-' + tabName).style.display = 'block';

  // 「スケジュール」タブを開いたときは、最新の統合スケジュールを再描画する
  if (tabName === 'schedule') {
    renderIntegratedSchedule();
  }

  // デスクトップ用タブボタンの切り替え
  const btnSchedule = document.getElementById('tabSchedule');
  const btnStudy = document.getElementById('tab-btn-study');
  const btnCoach = document.getElementById('tab-btn-coach');
  const btnAnalysis = document.getElementById('tab-btn-analysis');
  const btnReference = document.getElementById('tab-btn-reference');
  const buttons = { schedule: btnSchedule, study: btnStudy, coach: btnCoach, analysis: btnAnalysis, reference: btnReference };
  Object.keys(buttons).forEach(name => {
    if(buttons[name]) buttons[name].className = (name === tabName) ? 'btn-primary' : 'btn-ghost';
  });

  // モバイル用ボトムナビの active 切り替え
  const bnavItems = {
    schedule: document.getElementById('bnav-schedule'),
    study:    document.getElementById('bnav-study'),
    reference:document.getElementById('bnav-reference'),
    coach:    document.getElementById('bnav-coach'),
    analysis: document.getElementById('bnav-analysis'),
  };
  Object.keys(bnavItems).forEach(name => {
    const el = bnavItems[name];
    if (!el) return;
    if (name === tabName) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });

  // モバイルでタブ切り替え時に最上部へスクロール
  if (window.innerWidth <= 640) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// [ai-features.html] AI Coaching API Chat Logic（chatHistory / abortController / DOM参照 /
//                    appendMessage / handleChatSend / generateFinalPlan /
//                    continueChat / resetChat）→ ai-features.html に移動
// [ai-features.html] loadSavedApiKey / saveApiKey / setupApiKeyPersistence → ai-features.html に移動

(async function init(){
  buildWeekdayChips();
  buildWeekdayChips('reviewWeekdayRow', [0, 3, 6]);    // デフォルト：日・水・土
  buildIntervalChips();
  document.querySelectorAll('input[name="planMode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      document.getElementById('amountFieldWrap').style.display = e.target.value === 'byAmount' ? 'flex' : 'none';
    });
  });
  document.getElementById('startDate').value = todayISO();
  document.getElementById('addBtn').addEventListener('click', handleAdd);
  document.getElementById('resetBtn').addEventListener('click', handleReset);
  document.getElementById('leechAddBtn').addEventListener('click', handleLeechAdd);
  document.getElementById('printBtn').addEventListener('click', () => window.print());

  setupApiKeyPersistence();
  loadReviewDone();
  loadDailyProgress(); // 日別進捗データを読み込む
  await loadSavedApiKey();await loadEntries();
  renderAll();
  renderIntegratedSchedule(); // 「スケジュール」タブは初期表示タブなので、読み込み直後に描画する
  updateTodaySummaryCard();   // 今日のサマリーカードを初期表示
  await loadLeech();
  renderLeech();

  // ---- 成績・弱点分析タブの初期化 ----
  const scoreDateEl = document.getElementById('scoreDate');
  if(scoreDateEl) scoreDateEl.value = todayISO();
  if(document.getElementById('scoreAddBtn')) document.getElementById('scoreAddBtn').addEventListener('click', handleScoreAdd);
  if(document.getElementById('scoreFileInput')) document.getElementById('scoreFileInput').addEventListener('change', handleScoreImageFile);
  if(document.getElementById('runAnalysisBtn')) document.getElementById('runAnalysisBtn').addEventListener('click', runWeaknessAnalysis);
  await loadScores();
  renderScoreList();
  try {
    const savedAnalysis = localStorage.getItem(ANALYSIS_KEY);
    if(savedAnalysis) renderAnalysisResult(JSON.parse(savedAnalysis).result);
  } catch(e) {}
})();

/* =========================================================
   参考書スケジュール管理ロジック
========================================================= */

// ① 初期化（今日の日付をセットし、保存されたデータを読み込む）
window.addEventListener('DOMContentLoaded', () => {
  const refStartDateInput = document.getElementById('refStartDate');
  if(refStartDateInput) {
    const today = new Date();
    refStartDateInput.value = today.toISOString().split('T')[0];
  }

  // 学習する曜日のチップを生成（単語スケジュールと同じ仕組みを再利用）
  buildWeekdayChips('refWeekdayRow', DEFAULT_WEEKDAYS);
  buildWeekdayChips('refReviewWeekdayRow', [0, 3, 6]); // デフォルト：日・水・土
  // 復習インターバルは進捗入力時に DEFAULT_INTERVALS で自動生成するため、チップ選択UIは不要

  // 割り振り方法（曜日から設定 / 1日あたりの量から設定）の切り替え
  document.querySelectorAll('input[name="refPlanMode"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const isByAmount = e.target.value === 'byAmount';
      document.getElementById('refAmountFieldWrap').style.display = isByAmount ? 'block' : 'none';
      document.getElementById('refEndDateWrap').style.display = isByAmount ? 'none' : 'block';
    });
  });

  loadRefEntries();
  renderIntegratedSchedule(); // 参考書データの読み込み後にも「スケジュール」タブを最新化する
  renderRefTodayCard();       // 参考書「今日やること」カードを初期描画
});

// ①-2 参考書スケジュールの計算（単語スケジュールのcomputeChunksForEntryと同じ考え方）
// planMode === 'byAmount' : 1日あたりの量を指定 → 終了日は自動計算
// planMode === 'byRange'  : 開始日〜終了日と学習曜日を指定 → 1日あたりの量は自動計算
function computeRefSchedule(plan){
  const start = parseISO(plan.startDate);
  const total = plan.endNum - plan.startNum + 1;
  const chunks = [];

  if (plan.planMode === 'byAmount') {
    let cursor = plan.startNum;
    let daysAdded = 0;
    while (cursor <= plan.endNum) {
      const d = addDays(start, daysAdded);
      if (plan.weekdays.includes(d.getDay())) {
        const count = Math.min(plan.amountPerDay, plan.endNum - cursor + 1);
        const rangeStart = cursor;
        const rangeEnd = cursor + count - 1;
        chunks.push({ date: formatISO(d), rangeStart, rangeEnd, intervals: plan.intervals || [] });
        cursor = rangeEnd + 1;
      }
      daysAdded++;
      // 安全装置（万が一の無限ループ防止：最大10年）
      if (daysAdded > 3650) break;
    }
  } else {
    const end = parseISO(plan.endDate);
    const studyDates = [];
    let cursor = new Date(start);
    while (cursor <= end) {
      if (plan.weekdays.includes(cursor.getDay())) studyDates.push(new Date(cursor));
      cursor = addDays(cursor, 1);
      if (studyDates.length > 3650) break; // 安全装置
    }
    if (studyDates.length === 0) return [];

    const days = studyDates.length;
    const base = Math.floor(total / days);
    const rem = total % days;
    let numCursor = plan.startNum;

    studyDates.forEach((d, idx) => {
      const count = base + (idx < rem ? 1 : 0);
      if (count <= 0) return;
      const rangeStart = numCursor;
      const rangeEnd = numCursor + count - 1;
      chunks.push({ date: formatISO(d), rangeStart, rangeEnd });
      numCursor = rangeEnd + 1;
    });
  }
  return chunks;
}

// ② データの保存と読み込み
function saveRefEntries() {
  localStorage.setItem(REF_STORAGE_KEY, JSON.stringify(refEntries));
}
function loadRefEntries() {
  const saved = localStorage.getItem(REF_STORAGE_KEY);
  if (saved) {
    refEntries = JSON.parse(saved);
    renderRefSchedule(); // 読み込み後すぐに描画

    // 既にスケジュールが登録されている場合：設定アコーディオンを初期状態で閉じる
    // （「今日の確認」エリアを最初に見せることでUXを改善）
    if (refEntries.length > 0) {
      const settingDetails = document.getElementById('refSettingDetails');
      if (settingDetails) settingDetails.open = false;
    }
  }
}

// ③ 「スケジュールを登録」ボタンが押された時の処理
const saveRefPlanBtn = document.getElementById('saveRefPlanBtn');
if (saveRefPlanBtn) {
  saveRefPlanBtn.addEventListener('click', () => {
    const errorEl = document.getElementById('refErrorMsg');
    if (errorEl) errorEl.textContent = '';

    const bookName = document.getElementById('refBookName').value.trim();
    const startNum = parseInt(document.getElementById('refStartNum').value, 10);
    const endNum = parseInt(document.getElementById('refEndNum').value, 10);
    const startDate = document.getElementById('refStartDate').value;
    const planMode = document.querySelector('input[name="refPlanMode"]:checked').value;
    const weekdays = getCheckedValues('refWeekdayRow');
    const reviewWeekdays = getCheckedValues('refReviewWeekdayRow'); // ★復習曜日を取得

    const showError = (msg) => { if (errorEl) errorEl.textContent = msg; else alert(msg); };

    if (!bookName || isNaN(startNum) || isNaN(endNum) || !startDate) {
      showError('すべての項目を正しく入力してください。');
      return;
    }
    if (startNum > endNum) {
      showError('開始ページは終了ページ以下の数値を入力してください。');
      return;
    }
    if (weekdays.length === 0) {
      showError('学習する曜日を1つ以上選んでください。');
      return;
    }

    const newPlan = {
      id: 'ref_' + Date.now(),
      bookName: bookName,
      startNum: startNum,
      endNum: endNum,
      startDate: startDate,
      weekdays: weekdays,
      reviewWeekdays: reviewWeekdays, // ★復習曜日を保存
      planMode: planMode
    };

    if (planMode === 'byAmount') {
      const amount = parseInt(document.getElementById('refAmountPerDay').value, 10);
      if (!amount || amount <= 0) {
        showError('1日あたり進める量を正しく入力してください。');
        return;
      }
      newPlan.amountPerDay = amount;
    } else {
      const endDate = document.getElementById('refEndDate').value;
      if (!endDate) {
        showError('終了日を選択してください。');
        return;
      }
      if (parseISO(endDate) < parseISO(startDate)) {
        showError('終了日は開始日以降の日付にしてください。');
        return;
      }
      newPlan.endDate = endDate;
    }

    // 事前にスケジュールを計算し、該当日がなければ登録前に知らせる
    if (computeRefSchedule(newPlan).length === 0) {
      showError('指定した期間・曜日では学習日がありません。設定を見直してください。');
      return;
    }

    refEntries.push(newPlan);
    saveRefEntries();
    renderRefSchedule(); // 画面を更新
    
    // 入力欄をクリア（教材名・ページ番号のみ）
    document.getElementById('refBookName').value = '';
    document.getElementById('refStartNum').value = '';
    document.getElementById('refEndNum').value = '';

    // 登録完了後：設定アコーディオンを閉じて「今日の確認」に注目させる
    const settingDetails = document.getElementById('refSettingDetails');
    if (settingDetails) settingDetails.open = false;
  });
}

// ④ 参考書スケジュール：登録済みプランの一覧表示（単語タブのentryListと同じ考え方）
function renderRefEntryList(){
  const list = document.getElementById('refEntryList');
  if(!list) return;
  list.innerHTML = '';
  if(refEntries.length === 0) return;

  refEntries.forEach(plan => {
    const wdLabel = (plan.weekdays || []).slice().sort((a,b)=>a-b).map(i => WEEKDAYS[i]).join('・');
    const chunks = computeRefSchedule(plan);

    let calcInfo = '';
    if(chunks.length > 0){
      if(plan.planMode === 'byAmount'){
        const last = parseISO(chunks[chunks.length - 1].date);
        calcInfo = `1日あたり ${plan.amountPerDay} ／ 終了予定日 ${last.getMonth()+1}/${last.getDate()}（自動計算）`;
      } else {
        const amounts = chunks.map(c => c.rangeEnd - c.rangeStart + 1);
        const minA = Math.min(...amounts), maxA = Math.max(...amounts);
        calcInfo = (minA === maxA) ? `1日あたり ${minA}（自動計算）` : `1日あたり ${minA}〜${maxA}（自動計算）`;
      }
    } else {
      calcInfo = '該当する学習日がありません';
    }

    const item = document.createElement('div');
    item.className = 'entry-item';
    item.innerHTML = `
      <div>
        <span class="rng">${escapeHtml(plan.bookName)}　${plan.startNum}〜${plan.endNum}</span>
        <div class="meta">開始日 ${plan.startDate} ／ 学習日: ${wdLabel || '―'} ／ ${calcInfo} ／ 復習: 進捗入力時に自動設定</div>
      </div>
      <button class="del-btn ref-del-btn" data-id="${plan.id}">削除</button>
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('.ref-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('この参考書のスケジュールを削除しますか？')) return;
      refEntries = refEntries.filter(p => p.id !== btn.dataset.id);
      saveRefEntries();
      renderRefSchedule();
    });
  });
}

// ⑤ 参考書タブ全体の再描画（登録リスト＋今日やること）
function renderRefSchedule() {
  renderRefEntryList();
  refreshAllSchedules();
  renderRefTodayCard();
}

// 【追加】ラジオボタンで入力欄を切り替えるイベント
document.querySelectorAll('input[name="planMode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    if (e.target.value === 'byAmount') {
      document.getElementById('amountFieldWrap').style.display = ''; 
      document.getElementById('endDateWrap').style.display = 'none';
    } else {
      document.getElementById('amountFieldWrap').style.display = 'none';
      document.getElementById('endDateWrap').style.display = '';
    }
  });
});

// 期間ラジオボタンが切り替わったら再描画
document.querySelectorAll('input[name="schedulePeriod"]').forEach(radio => {
  radio.addEventListener('change', renderIntegratedSchedule);
});
