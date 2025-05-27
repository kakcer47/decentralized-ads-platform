console.log("Decentralized Ads Platform is starting...");

// Инициализация IPFS
let ipfs;
async function initIPFS() {
  try {
    ipfs = await IPFS.create();
    console.log("IPFS node started:", await ipfs.id());
  } catch (error) {
    console.error("Failed to initialize IPFS:", error);
  }
}

// Функция для создания объявления (заглушка)
async function createAd() {
  const title = document.getElementById("ad-title").value;
  const content = document.getElementById("ad-content").value;
  if (!title || !content) {
    alert("Please fill in both title and description!");
    return;
  }
  console.log("Creating ad:", { title, content });
  // Здесь будет интеграция с IPFS и блокчейном
}

// Запуск
initIPFS();