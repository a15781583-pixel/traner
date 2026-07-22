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
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
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
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
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

// スコア画像処理用の関数（未定義エラーを防ぐための記述）
if (typeof handleScoreImageFile === 'undefined') {
  window.handleScoreImageFile = function(event) {
    console.log('Score image selected:', event.target.files[0]);
    // 画像読み込みや解析の処理が必要な場合はここに記述
  };
}
