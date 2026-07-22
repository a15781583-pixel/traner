/* ============================================================
   js-ai-features.js - AI機能 & API連携モジュール
============================================================ */

// 1. スコア画像アップロード用の関数（エラー防止用ダミー兼定義）
window.handleScoreImageFile = window.handleScoreImageFile || function(event) {
  const file = event.target?.files?.[0];
  if (file) {
    console.log('Score image selected:', file.name);
  }
};

// 2. 弱点分析用の関数
window.runWeaknessAnalysis = window.runWeaknessAnalysis || async function() {
  console.log('Running weakness analysis...');
  const resultDiv = document.getElementById('analysis-result');
  if (resultDiv) {
    resultDiv.innerHTML = '<p class="loading">AIが弱点を分析中...</p>';
    // ここに分析ロジックやAPI呼び出しを記述
  }
};

// 3. 学習計画作成用の関数
window.generateStudyPlan = window.generateStudyPlan || async function() {
  console.log('Generating study plan...');
  const planDiv = document.getElementById('plan-result');
  if (planDiv) {
    planDiv.innerHTML = '<p class="loading">AIが学習計画を作成中...</p>';
    // ここに計画作成ロジックやAPI呼び出しを記述
  }
};

// 4. APIキー保存用の関数
window.setupApiKeyPersistence = window.setupApiKeyPersistence || function() {
  const keyInput = document.getElementById('gemini-api-key');
  if (keyInput) {
    // 保存されているキーがあれば復元
    const savedKey = localStorage.getItem('gemini_api_key');
    if (savedKey) keyInput.value = savedKey;

    keyInput.addEventListener('change', (e) => {
      localStorage.setItem('gemini_api_key', e.target.value);
    });
  }
};

// 5. 画面読み込み完了時の初期化処理
document.addEventListener('DOMContentLoaded', () => {
  console.log('AI Features initialized.');
  if (typeof window.setupApiKeyPersistence === 'function') {
    window.setupApiKeyPersistence();
  }

  // チャット送信ボタンのイベントリスナー設定
  const sendBtn = document.getElementById('send-ai-btn') || document.querySelector('.ai-send-btn');
  const chatInput = document.getElementById('ai-chat-input') || document.querySelector('.ai-chat-input');

  if (sendBtn && chatInput) {
    sendBtn.addEventListener('click', () => {
      const message = chatInput.value.trim();
      if (message) {
        console.log('Sending message:', message);
        // 送信処理（API呼出しなど）
        chatInput.value = '';
      }
    });
  }
});
