/* ============================================================
   AI機能専用JavaScript (js/ai-features.js)
============================================================ */

const API_KEY_STORAGE_KEY = 'vocab-gemini-api-key';
let chatHistory = []; 
let abortController = null; 


// デスクトップ・モバイルナビゲーションバーへAIタブボタンを追加挿入
function injectAiNavButtons() {
  const desktopTemplate = document.getElementById('ai-nav-desktop-template');
  const mobileTemplate = document.getElementById('ai-nav-mobile-template');

  const desktopBar = document.querySelector('.desktop-tab-bar');
  const mobileBar = document.querySelector('.bottom-nav');

  if (desktopBar && desktopTemplate) {
    desktopBar.appendChild(desktopTemplate.content.cloneNode(true));
  }
  if (mobileBar && mobileTemplate) {
    mobileBar.appendChild(mobileTemplate.content.cloneNode(true));
  }
}

// AI機能の初期化・イベントリスナー登録
function initAiFeatures() {
  loadSavedApiKey();
  setupApiKeyPersistence();

  const chatSendBtn = document.getElementById('chatSendBtn');
  const chatInput = document.getElementById('chatInput');
  const chatStopBtn = document.getElementById('chatStopBtn');
  const fileInput = document.getElementById('chatFileInput');
  const clearImgBtn = document.getElementById('clearImageBtn');
  const generatePlanBtn = document.getElementById('generatePlanBtn');
  const scoreFileInput = document.getElementById('scoreFileInput');
  const runAnalysisBtn = document.getElementById('runAnalysisBtn');

  if (chatSendBtn) chatSendBtn.addEventListener('click', handleChatSend);
  if (chatInput) chatInput.addEventListener('keypress', (e) => { if(e.key === 'Enter') handleChatSend(); });
  if (chatStopBtn) chatStopBtn.addEventListener('click', () => { if (abortController) abortController.abort(); });
  if (generatePlanBtn) generatePlanBtn.addEventListener('click', generateFinalPlan);
  if (scoreFileInput) scoreFileInput.addEventListener('change', handleScoreImageFile);
  if (runAnalysisBtn) runAnalysisBtn.addEventListener('click', runWeaknessAnalysis);

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
          document.getElementById('imagePreview').src = e.target.result;
          document.getElementById('imagePreviewContainer').style.display = 'block';
        };
        reader.readAsDataURL(file);
      }
    });
  }
  if (clearImgBtn) {
    clearImgBtn.addEventListener('click', () => {
      if (fileInput) fileInput.value = '';
      document.getElementById('imagePreviewContainer').style.display = 'none';
      document.getElementById('imagePreview').src = '';
    });
  }
}

/* --- APIキーの復元・自動保存 --- */
async function loadSavedApiKey() {
  try {
    const input = document.getElementById('geminiApiKey');
    if (!input) return;
    if (typeof window.storage !== 'undefined') {
      const res = await window.storage.get(API_KEY_STORAGE_KEY, true);
      if(res && res.value) input.value = res.value;
    } else {
      const saved = localStorage.getItem(API_KEY_STORAGE_KEY);
      if(saved) input.value = saved;
    }
  } catch(e) {}
}

let apiKeySaveTimer = null;
async function saveApiKey(value) {
  try {
    if (typeof window.storage !== 'undefined') {
      await window.storage.set(API_KEY_STORAGE_KEY, value, true);
    } else {
      if (value) localStorage.setItem(API_KEY_STORAGE_KEY, value);
      else localStorage.removeItem(API_KEY_STORAGE_KEY);
    }
  } catch(e) {}
}

function setupApiKeyPersistence() {
  const apiKeyInput = document.getElementById('geminiApiKey');
  if (!apiKeyInput) return;
  apiKeyInput.addEventListener('input', () => {
    clearTimeout(apiKeySaveTimer);
    apiKeySaveTimer = setTimeout(() => saveApiKey(apiKeyInput.value.trim()), 400);
  });
}

/* --- ヘルパー関数 --- */
function parseJsonFromText(text){
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse(raw.trim());
}

function fileToGenerativePart(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64Data = reader.result.split(',')[1];
      resolve({ inlineData: { data: base64Data, mimeType: file.type } });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* --- チャット・プラン生成ロジック --- */
function appendMessage(text, isUser, imgSrc = null) {
  const box = document.getElementById('chatBox');
  if (!box) return;
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-msg ${isUser ? 'user-msg' : 'model-msg'}`;

  if (isUser) msgDiv.dataset.historyIndex = chatHistory.length;

  if (imgSrc) {
    const img = document.createElement('img');
    img.src = imgSrc;
    img.style.maxWidth = '100%';
    img.style.maxHeight = '150px';
    img.style.borderRadius = '8px';
    img.style.marginBottom = '6px';
    img.style.display = 'block';
    msgDiv.appendChild(img);
  }

  if (text) {
    const textSpan = document.createElement('span');
    textSpan.textContent = text;
    msgDiv.appendChild(textSpan);
  }

  box.appendChild(msgDiv);
  box.scrollTop = box.scrollHeight;
}

async function handleChatSend() {
  const apiKey = document.getElementById('geminiApiKey').value.trim();
  const errorEl = document.getElementById('coachErrorMsg');
  if(!apiKey) { if(errorEl) errorEl.textContent = 'APIキーを入力してください。'; return; }
  if(errorEl) errorEl.textContent = '';

  const chatInput = document.getElementById('chatInput');
  const fileInput = document.getElementById('chatFileInput');
  const text = chatInput ? chatInput.value.trim() : '';
  const file = fileInput ? fileInput.files[0] : null;

  if(!text && !file) return;

  const parts = [];
  if (text) parts.push({ text: text });
  if (file) parts.push(await fileToGenerativePart(file));

  abortController = new AbortController();
  document.getElementById('chatSendBtn').style.display = 'none';
  document.getElementById('chatStopBtn').style.display = 'inline-block';

  appendMessage(text, true, file ? document.getElementById('imagePreview').src : null);
  chatHistory.push({ role: 'user', parts: parts });

  chatInput.value = '';
  fileInput.value = '';
  document.getElementById('imagePreviewContainer').style.display = 'none';
  chatInput.disabled = true;

  const chatBox = document.getElementById('chatBox');
  const loadingIndicator = document.createElement('div');
  loadingIndicator.className = 'typing-indicator chat-msg';
  loadingIndicator.innerHTML = '<span></span><span></span><span></span>';
  chatBox.appendChild(loadingIndicator);
  chatBox.scrollTop = chatBox.scrollHeight;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "あなたはプロの学習プランナーです。ユーザーの目標達成のためのロードマップを作るために、現状をヒアリングしてください。" }] },
        contents: chatHistory
      }),
      signal: abortController.signal
    });

    loadingIndicator.remove();
    if (!response.ok) throw new Error(`APIエラー (Status: ${response.status})`);

    const data = await response.json();
    const aiResponseText = data.candidates[0].content.parts[0].text;

    appendMessage(aiResponseText, false);
    chatHistory.push({ role: 'model', parts: [{ text: aiResponseText }] });
  } catch (error) {
    loadingIndicator.remove();
    if (error.name !== 'AbortError') {
      if(errorEl) errorEl.textContent = '通信エラー: ' + error.message;
    }
  } finally {
    abortController = null;
    document.getElementById('chatSendBtn').style.display = 'inline-block';
    document.getElementById('chatStopBtn').style.display = 'none';
    chatInput.disabled = false;
    chatInput.focus();
  }
}

async function generateFinalPlan() {
  const apiKey = document.getElementById('geminiApiKey').value.trim();
  if(!apiKey || chatHistory.length === 0) return;

  document.getElementById('coachChatSection').style.display = 'none';
  document.getElementById('coachResultSection').style.display = 'block';
  document.getElementById('coachLoading').style.display = 'block';

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [...chatHistory, { role: 'user', parts: [{ text: "これまでの対話履歴をすべて分析し、学習ロードマップを作成してください。" }] }] })
    });
    const data = await response.json();
    let text = data.candidates[0].content.parts[0].text;
    document.getElementById('coachOutput').innerHTML = typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(text) : text;
  } catch (e) {
    document.getElementById('coachOutput').innerHTML = 'エラーが発生しました。';
  } finally {
    document.getElementById('coachLoading').style.display = 'none';
  }
}

function continueChat() {
  document.getElementById('coachResultSection').style.display = 'none';
  document.getElementById('coachChatSection').style.display = 'block';
}

function resetChat() {
  if (confirm('チャットを最初からやり直しますか？')) {
    chatHistory.length = 0;
    document.getElementById('chatBox').innerHTML = '<div class="chat-msg model-msg">こんにちは！目標を教えてください！</div>';
    continueChat();
  }
}

/* --- 成績画像プレビュー --- */
function handleScoreImageFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  const preview = document.getElementById('scoreImagePreview');
  const container = document.getElementById('scoreImagePreviewContainer');
  if (!preview || !container) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    preview.src = e.target.result;
    container.style.display = 'block';
  };
  reader.readAsDataURL(file);
}

/* --- AI弱点分析 --- */
async function runWeaknessAnalysis() {
  const apiKeyEl = document.getElementById('geminiApiKey');
  const apiKey = apiKeyEl ? apiKeyEl.value.trim() : '';
  const errorEl = document.getElementById('analysisErrorMsg');
  const loadingEl = document.getElementById('analysisLoading');
  const runBtn = document.getElementById('runAnalysisBtn');

  if (!apiKey) {
    if (errorEl) errorEl.textContent = 'APIキーを入力してください（AI学習計画タブで設定）。';
    return;
  }
  // scoreRecords はjs-app.jsのグローバル変数
  if (typeof scoreRecords === 'undefined' || scoreRecords.length === 0) {
    if (errorEl) errorEl.textContent = '成績データがありません。先に成績を登録してください。';
    return;
  }

  if (errorEl) errorEl.textContent = '';
  if (loadingEl) loadingEl.style.display = 'block';
  if (runBtn) runBtn.disabled = true;

  const scoreSummary = scoreRecords.map(r => {
    const pct = r.total ? Math.round((r.score / r.total) * 100) : '?';
    return `${r.date} - ${r.subject}${r.category ? '/' + r.category : ''}${r.examType ? ' (' + r.examType + ')' : ''}: ${r.score}/${r.total}点（${pct}%）${r.deviation != null ? ' 偏差値' + r.deviation : ''}${r.note ? ' メモ: ' + r.note : ''}`;
  }).join('\n');

  const prompt = `以下は生徒の成績データです。各教科・分野の得点率や偏差値を分析し、弱点と今後の優先的な学習アドバイスを具体的にまとめてください。\n\n【成績データ】\n${scoreSummary}`;

  const parts = [{ text: prompt }];
  const fileInput = document.getElementById('scoreFileInput');
  if (fileInput && fileInput.files[0]) {
    try { parts.push(await fileToGenerativePart(fileInput.files[0])); } catch(e) {}
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts }] })
    });
    if (!response.ok) throw new Error(`APIエラー (Status: ${response.status})`);
    const data = await response.json();
    const result = data.candidates[0].content.parts[0].text;
    try {
      // ANALYSIS_KEY はjs-app.jsのグローバル定数 'vocab-weakness-analysis'
      localStorage.setItem(typeof ANALYSIS_KEY !== 'undefined' ? ANALYSIS_KEY : 'vocab-weakness-analysis',
        JSON.stringify({ result, date: typeof todayISO === 'function' ? todayISO() : new Date().toISOString().slice(0,10) }));
    } catch(e) {}
    renderAnalysisResult(result);
    if (fileInput) fileInput.value = '';
    const container = document.getElementById('scoreImagePreviewContainer');
    if (container) container.style.display = 'none';
  } catch(e) {
    if (errorEl) errorEl.textContent = 'エラー: ' + e.message;
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
    if (runBtn) runBtn.disabled = false;
  }
}

function renderAnalysisResult(result) {
  const output = document.getElementById('analysisOutput');
  if (!output) return;
  const sanitized = typeof DOMPurify !== 'undefined'
    ? DOMPurify.sanitize(result.replace(/\n/g, '<br>'))
    : result.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
  output.innerHTML = sanitized;
  output.style.display = 'block';
  // 分析結果エリアへスクロール
  output.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* --- js-ai-features.js が defer で読み込まれる際、DOMContentLoadedは既に発火済みのため直接初期化 --- */
// (両スクリプトともdeferのため js-app.js → js-ai-features.js の順で実行される)
initAiFeatures();

// js-app.jsのinit()が先に実行されrenderAnalysisResultが未定義だった場合のリカバリ
try {
  const savedKey = typeof ANALYSIS_KEY !== 'undefined' ? ANALYSIS_KEY : 'vocab-weakness-analysis';
  const savedAnalysis = localStorage.getItem(savedKey);
  if (savedAnalysis) renderAnalysisResult(JSON.parse(savedAnalysis).result);
} catch(e) {}
