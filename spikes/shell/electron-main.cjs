// Electron side of the WebGL bench. URL comes from BENCH_URL.
const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1600, height: 1000, show: true, backgroundColor: "#1b1d22",
    webPreferences: { backgroundThrottling: false } });
  win.loadURL(process.env.BENCH_URL);
});
app.on("window-all-closed", () => app.quit());
