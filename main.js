console.log("Decentralized Ads Platform is starting...");

// Инициализация IPFS
let ipfs;
async function initIPFS() {
  try {
    if (typeof IPFS === 'undefined') {
      throw new Error("IPFS is not defined. Ensure the ipfs-core script is loaded correctly.");
    }
    ipfs = await IPFS.create();
    console.log("IPFS node started:", await ipfs.id());
  } catch (error) {
    console.error("Failed to initialize IPFS:", error);
  }
}

// Генерация ключей для аутентификации
let keys;
window.generateKeys = async function() {
  try {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    keys = keyPair;
    console.log("Keys generated successfully");
    await displayKeys();
  } catch (error) {
    console.error("Failed to generate keys:", error);
  }
};

// Отображение ключей для пользователя (для сохранения)
async function displayKeys() {
  try {
    const exportedKey = await crypto.subtle.exportKey('spki', keys.publicKey);
    const keyArray = new Uint8Array(exportedKey);
    const publicKey = btoa(String.fromCharCode(...keyArray));
    document.getElementById("ads-list").innerHTML += `<p>Your Public Key (save this): ${publicKey}</p>`;
  } catch (error) {
    console.error("Failed to export public key:", error);
  }
}

// Функция для создания объявления
window.createAd = async function() {
  const title = document.getElementById("ad-title").value;
  const content = document.getElementById("ad-content").value;
  if (!title || !content || !ipfs || !keys) {
    alert("Please fill in both title and description, and ensure IPFS/keys are ready!");
    return;
  }

  try {
    // Создание и загрузка объявления в IPFS
    const ad = { title, content, timestamp: Date.now() };
    const { cid } = await ipfs.add(JSON.stringify(ad));
    console.log("Ad uploaded to IPFS, CID:", cid.toString());

    // Подпись объявления
    const transaction = { cid: cid.toString(), title, category: 'default' };
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.privateKey,
      Buffer.from(JSON.stringify(transaction))
    );
    const signatureArray = new Uint8Array(signature);
    const signedTx = { ...transaction, signature: btoa(String.fromCharCode(...signatureArray)) };

    // Добавление в блокчейн
    await blockchain.addTransaction(signedTx);
    displayAd(cid.toString(), title, content);
  } catch (error) {
    console.error("Failed to create ad:", error);
  }
};

// Отображение объявления на странице
function displayAd(cid, title, content) {
  const adsList = document.getElementById("ads-list");
  adsList.innerHTML += `<div><strong>${title}</strong><p>${content} (CID: ${cid})</p></div>`;
}

// Блокчейн (начальная структура)
class Blockchain {
  constructor() {
    this.chain = [{ hash: '0', transactions: [], prevHash: null }]; // Генезис-блок
    this.authorities = new Set(); // Доверенные узлы (PoA)
  }

  async addTransaction(transaction) {
    const lastBlock = this.chain[this.chain.length - 1];
    const newBlock = {
      hash: await this.hashBlock([transaction], lastBlock.hash),
      transactions: [transaction],
      prevHash: lastBlock.hash,
      timestamp: Date.now()
    };
    this.chain.push(newBlock);
    console.log("New block added:", newBlock);
    // Здесь будет синхронизация через WebRTC
  }

  async hashBlock(transactions, prevHash) {
    const data = JSON.stringify({ transactions, prevHash });
    const buffer = await crypto.subtle.digest('SHA-256', Buffer.from(data));
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  isAuthority() {
    // Простая логика: узел становится авторитетом после 5 минут онлайн
    return Date.now() - window.startTime > 5 * 60 * 1000;
  }
}

let blockchain = new Blockchain();
window.startTime = Date.now();

// Привязка событий к кнопкам
document.addEventListener('DOMContentLoaded', () => {
  console.log("DOM loaded, binding events...");
  const generateKeysBtn = document.getElementById("generate-keys-btn");
  const createAdBtn = document.getElementById("create-ad-btn");
  
  if (generateKeysBtn && createAdBtn) {
    generateKeysBtn.addEventListener('click', generateKeys);
    createAdBtn.addEventListener('click', createAd);
    document.getElementById("ads-list").innerHTML = "<h2>Published Ads</h2>";
  } else {
    console.error("Could not find buttons for event binding");
  }
});

// Запуск
(async () => {
  console.log("Starting initialization...");
  await initIPFS();
  await generateKeys();
})();