const btn = document.getElementById("go");
const status = document.getElementById("status");
btn.addEventListener("click", async () => {
  btn.disabled = true;
  status.className = "";
  status.textContent = "Capturing…";
  try {
    const resp = await chrome.runtime.sendMessage({ type: "CAPTURE" });
    if (!resp?.ok) throw new Error(resp?.error || "Capture failed");
    status.className = "ok";
    status.textContent = "Reader tab opened.";
  } catch (e) {
    status.className = "error";
    status.textContent = String(e?.message || e);
  } finally {
    btn.disabled = false;
  }
});
