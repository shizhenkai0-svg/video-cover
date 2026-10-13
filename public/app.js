const input = document.querySelector("#input");
const extractBtn = document.querySelector("#extract");
const pasteBtn = document.querySelector("#paste");
const clearBtn = document.querySelector("#clear");
const statusEl = document.querySelector("#status");
const resultEl = document.querySelector("#result");
const coverEl = document.querySelector("#cover");
const videoEl = document.querySelector("#frame-source");
const platformEl = document.querySelector("#platform");
const titleEl = document.querySelector("#title");
const authorEl = document.querySelector("#author");
const downloadEl = document.querySelector("#download");
const copyBtn = document.querySelector("#copy");
const openEl = document.querySelector("#open");

let lastCoverUrl = "";

function setStatus(message, isError = false) {
  statusEl.hidden = !message;
  statusEl.textContent = message || "";
  statusEl.classList.toggle("error", Boolean(isError));
}

function showResult(data, coverUrl) {
  lastCoverUrl = coverUrl;
  platformEl.textContent = data.platform || "未知平台";
  titleEl.textContent = data.title || "已提取封面";
  authorEl.textContent = data.author ? `作者：${data.author}` : "";
  coverEl.src = `/api/image?url=${encodeURIComponent(coverUrl)}`;
  downloadEl.href = `/api/download?url=${encodeURIComponent(coverUrl)}`;
  openEl.href = data.pageUrl || coverUrl;
  resultEl.hidden = false;
}

function grabFrame(videoUrl) {
  return new Promise((resolve, reject) => {
    videoEl.src = `/api/image?url=${encodeURIComponent(videoUrl)}`;
    videoEl.onerror = () => reject(new Error("无法从视频中截取封面，请确认直链可访问"));
    videoEl.onloadeddata = () => {
      videoEl.currentTime = Math.min(0.4, (videoEl.duration || 1) / 8);
    };
    videoEl.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = videoEl.videoWidth || 1280;
        canvas.height = videoEl.videoHeight || 720;
        canvas.getContext("2d").drawImage(videoEl, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.92));
      } catch (error) {
        reject(error);
      }
    };
  });
}

async function extractCover() {
  const value = input.value.trim();
  if (!value) {
    setStatus("请先输入视频链接或视频号", true);
    return;
  }

  extractBtn.disabled = true;
  resultEl.hidden = true;
  setStatus("正在识别平台并提取封面…");

  try {
    const response = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: value }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || "提取失败");

    if (data.extractFrame && data.videoUrl) {
      setStatus("未找到现成封面，正在截取视频画面…");
      const frame = await grabFrame(data.videoUrl);
      coverEl.src = frame;
      downloadEl.href = frame;
      lastCoverUrl = frame;
      platformEl.textContent = data.platform;
      titleEl.textContent = data.title || "视频画面";
      authorEl.textContent = "";
      openEl.href = data.pageUrl || data.videoUrl;
      resultEl.hidden = false;
      setStatus("已从视频画面生成封面");
      return;
    }

    if (!data.coverUrl) throw new Error("没有找到封面图");
    showResult(data, data.coverUrl);
    setStatus("提取成功");
  } catch (error) {
    setStatus(error.message || "提取失败", true);
  } finally {
    extractBtn.disabled = false;
  }
}

extractBtn.addEventListener("click", extractCover);
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) extractCover();
});

pasteBtn.addEventListener("click", async () => {
  try {
    input.value = await navigator.clipboard.readText();
    setStatus("已粘贴，点击提取封面");
  } catch {
    setStatus("无法读取剪贴板，请手动粘贴", true);
  }
});

clearBtn.addEventListener("click", () => {
  input.value = "";
  resultEl.hidden = true;
  setStatus("");
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(lastCoverUrl);
    setStatus("封面地址已复制");
  } catch {
    setStatus("复制失败", true);
  }
});
