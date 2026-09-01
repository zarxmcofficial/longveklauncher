process.noDeprecation = true;
const { app, BrowserWindow, ipcMain, shell, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const extract = require('extract-zip');
const { Client, Authenticator } = require('minecraft-launcher-core');
const msmc = require('msmc');
const DiscordRPC = require('discord-rpc');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;
let splashWindow = null;
let isLaunchAborted = false;
let updateInProgress = false;
const launcher = new Client();

// កំណត់ទីតាំង Game Directory មូលដ្ឋានក្នុង AppData
const rootPath = path.join(app.getPath('appData'), '.minecraft');
const modsDir = path.join(rootPath, 'mods');
const resourcePacksDir = path.join(rootPath, 'resourcepacks');
const shaderPacksDir = path.join(rootPath, 'shaderpacks');
const runtimesDir = path.join(rootPath, 'runtimes');

// បង្កើត Folders ស្វ័យប្រវត្តិប្រសិនបើមិនទាន់មាន
[rootPath, modsDir, resourcePacksDir, shaderPacksDir, runtimesDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

const clientId = '1528784445123858523';
let rpcEnabled = true;
let rpc = null;
let currentRpcState = 'In Launcher';
let currentRpcDetails = 'Preparing to play...';
const startTimestamp = new Date();

function initDiscordRPC() {
    if (!rpcEnabled || rpc) return;
    try {
        rpc = new DiscordRPC.Client({ transport: 'ipc' });
        rpc.on('ready', () => {
            console.log('Discord RPC Connected!');
            updateRPCActivity();
        });
        rpc.login({ clientId }).catch(() => {
            console.log('Discord RPC Login Failed.');
        });
    } catch (err) {
        console.error('Discord RPC Init Error:', err);
    }
}

function destroyDiscordRPC() {
    if (rpc) {
        try {
            rpc.clearActivity();
            rpc.destroy();
        } catch (e) {
            console.error('Error clearing RPC:', e);
        }
        rpc = null;
    }
}

async function setActivity(state, details) {
    currentRpcState = state;
    currentRpcDetails = details;
    updateRPCActivity();
}

async function updateRPCActivity() {
    if (!rpcEnabled || !rpc) return;
    try {
        await rpc.setActivity({
            details: currentRpcDetails,
            state: currentRpcState,
            startTimestamp,
            largeImageKey: 'longveklogo',
            largeImageText: 'LONGVEKMC LAUNCHER',
            instance: false
        });
    } catch (e) {
        console.error('Discord RPC Error:', e);
    }
}

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowPrerelease = false;

// ភ្ជាប់ Provider ទៅកាន់ GitHub Repository ដោយផ្ទាល់
autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'zarxmcofficial',
    repo: 'longveklauncher'
});

function sendSplashStatus(msg, progress = -1, isDone = false) {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.webContents.send('splash-update-status', { msg, progress, isDone });
    }
}

function initAutoUpdater() {
    autoUpdater.on('checking-for-update', () => {
        console.log('[AutoUpdater] Checking for updates on GitHub...');
        sendSplashStatus('Checking for launcher updates...', 20);
    });

    autoUpdater.on('update-available', (info) => {
        updateInProgress = true;
        console.log(`[AutoUpdater] Update found: v${info.version}`);
        sendSplashStatus(`New version v${info.version} found! Downloading...`, 35);
    });

    autoUpdater.on('update-not-available', (info) => {
        console.log('[AutoUpdater] Up to date:', info ? info.version : 'Latest');
        sendSplashStatus('Launcher is up to date!', 100);
        setTimeout(() => {
            finishSplashAndOpenMain();
        }, 800);
    });

    autoUpdater.on('download-progress', (progressObj) => {
        const percent = Math.round(progressObj.percent || 0);
        console.log(`[AutoUpdater] Downloading: ${percent}%`);
        sendSplashStatus(`Downloading update: ${percent}%`, percent);
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log(`[AutoUpdater] Update v${info.version} downloaded successfully!`);
        sendSplashStatus(`Update v${info.version} ready! Restarting...`, 100, true);
        setTimeout(() => {
            // បញ្ជាឱ្យបិទកម្មវិធីរួចដំឡើង Setup ថ្មីភ្លាមៗ
            autoUpdater.quitAndInstall(false, true);
        }, 1500);
    });

    autoUpdater.on('error', (err) => {
        console.error('[AutoUpdater Error]:', err ? err.message : err);
        sendSplashStatus('Starting launcher...', 100);
        setTimeout(() => {
            finishSplashAndOpenMain();
        }, 1000);
    });
}

function createSplashWindow() {
    splashWindow = new BrowserWindow({
        width: 480,
        height: 320,
        frame: false,
        transparent: true,
        resizable: false,
        center: true,
        alwaysOnTop: true,
        backgroundColor: '#00000000',
        icon: path.join(__dirname, 'icon.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // បង្កើតទិដ្ឋភាព Splash Screen ស្រស់ស្អាតជាមួយ Sound Effect "Ding" និង Progress Bar
    const splashHtml = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Kantumruy+Pro:wght@400;600;700;800&display=swap" rel="stylesheet">
        <style>
            * { font-family: 'Kantumruy Pro', sans-serif; user-select: none; }
            @keyframes pulseGlow {
                0%, 100% { transform: scale(1); filter: drop-shadow(0 0 15px rgba(37, 99, 235, 0.6)); }
                50% { transform: scale(1.04); filter: drop-shadow(0 0 28px rgba(96, 165, 250, 0.9)); }
            }
            .animate-logo { animation: pulseGlow 2.4s ease-in-out infinite; }
        </style>
    </head>
    <body class="bg-transparent flex items-center justify-center h-screen m-0 p-4">
        <div class="w-full h-full rounded-3xl bg-[#060D1A]/95 border border-blue-500/30 p-6 flex flex-col items-center justify-between shadow-2xl backdrop-blur-xl relative overflow-hidden">
            <!-- Background Glow -->
            <div class="absolute -top-12 left-1/2 -translate-x-1/2 w-48 h-48 bg-blue-600/20 rounded-full blur-3xl pointer-events-none"></div>

            <!-- Top Logo & Title -->
            <div class="flex flex-col items-center gap-2 pt-2 z-10">
                <img src="https://i.postimg.cc/yYwMV4MX/longveklogo.png" onerror="this.onerror=null; this.src='https://placehold.co/120x120/0B132B/2563EB?text=LMC';" class="w-16 h-16 object-contain animate-logo" />
                <div class="text-center">
                    <h1 class="text-xl font-extrabold tracking-wider bg-gradient-to-r from-blue-400 via-blue-200 to-white bg-clip-text text-transparent">LONGVEKMC</h1>
                    <p class="text-[10px] text-blue-300/80 font-bold uppercase tracking-widest">Next-Gen Minecraft Launcher</p>
                </div>
            </div>

            <!-- Bottom Progress & Status -->
            <div class="w-full space-y-2 z-10">
                <div class="flex justify-between text-xs font-semibold px-1">
                    <span id="statusTxt" class="text-blue-200 text-[11px] truncate max-w-[300px]">Starting launcher services...</span>
                    <span id="percentTxt" class="text-blue-400 font-mono text-[11px]">0%</span>
                </div>
                <div class="w-full h-2 bg-slate-950 rounded-full overflow-hidden p-0.5 border border-blue-900/50">
                    <div id="bar" class="h-full bg-gradient-to-r from-blue-600 to-blue-400 rounded-full transition-all duration-300 w-0 shadow-lg shadow-blue-500/50"></div>
                </div>
            </div>
        </div>

        <script>
            // ទទួលទិន្នន័យ Status ពី main.js
            window.addEventListener('DOMContentLoaded', () => {
                if (window.electronAPI && window.electronAPI.onSplashUpdateStatus) {
                    window.electronAPI.onSplashUpdateStatus((data) => {
                        const statusTxt = document.getElementById('statusTxt');
                        const percentTxt = document.getElementById('percentTxt');
                        const bar = document.getElementById('bar');

                        if (statusTxt && data.msg) statusTxt.innerText = data.msg;
                        if (data.progress >= 0) {
                            if (percentTxt) percentTxt.innerText = data.progress + '%';
                            if (bar) bar.style.width = data.progress + '%';
                        }
                    });
                }
            });
        </script>
    </body>
    </html>
    `;

    splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml));

    splashWindow.webContents.on('did-finish-load', () => {
        if (app.isPackaged) {
            autoUpdater.checkForUpdates().catch((err) => {
                console.error('[AutoUpdater Check Error]:', err);
                sendSplashStatus('Starting launcher...', 100);
                setTimeout(finishSplashAndOpenMain, 1000);
            });
        } else {
            // Development Mode Simulation
            sendSplashStatus('Development Environment Ready', 40);
            setTimeout(() => sendSplashStatus('Initializing Core Components...', 80), 600);
            setTimeout(() => {
                sendSplashStatus('Ready to play!', 100);
                setTimeout(finishSplashAndOpenMain, 600);
            }, 1200);
        }
    });
}

function finishSplashAndOpenMain() {
    if (mainWindow && !mainWindow.isDestroyed()) return;
    createWindow();
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.close();
        splashWindow = null;
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1120,
        height: 720,
        minWidth: 920,
        minHeight: 620,
        frame: false,
        transparent: true,
        backgroundColor: '#060D1A',
        icon: path.join(__dirname, 'LONGVEKLAUNCHER.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: true,
            devTools: true
        }
    });

    // បោសសម្អាត Cache ទាំងស្រុងដើម្បីធានាថាទាញយក index.html ថ្មី ១០០%
    if (mainWindow.webContents.session) {
        mainWindow.webContents.session.clearCache();
        mainWindow.webContents.session.clearStorageData({
            storages: ['appcache', 'cachestorage', 'serviceworkers', 'shadercache']
        });
    }

    // Load ឯកសារ index.html តាមរយៈ path.join(__dirname) ជាមួយ Cache Buster
    const indexPath = path.join(__dirname, 'index.html');
    mainWindow.loadFile(indexPath, { query: { v: app.getVersion() } });

    mainWindow.on('maximize', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('window-state', 'maximized');
        }
    });

    mainWindow.on('unmaximize', () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('window-state', 'unmaximized');
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    initDiscordRPC();
    initAutoUpdater();
    createSplashWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0 && !splashWindow) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (session.defaultSession) {
        session.defaultSession.flushStorageData();
    }
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.on('minimize-window', () => {
    if (mainWindow) mainWindow.minimize();
});

ipcMain.on('maximize-window', () => {
    if (mainWindow) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
    }
});

ipcMain.on('close-window', () => {
    app.quit();
});

ipcMain.on('open-external-link', (_event, url) => {
    if (typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
        shell.openExternal(url);
    }
});

ipcMain.handle('get-system-memory', () => {
    const totalMemBytes = os.totalmem();
    const totalMemGb = Math.round(totalMemBytes / (1024 * 1024 * 1024));
    return {
        totalGb: totalMemGb,
        totalMb: Math.floor(totalMemBytes / (1024 * 1024)),
        freeGb: (os.freemem() / (1024 * 1024 * 1024)).toFixed(1)
    };
});

ipcMain.on('request-system-info', (event) => {
    const totalRamMB = Math.floor(os.totalmem() / (1024 * 1024));
    event.reply('system-info', { totalRamMB });
});

ipcMain.on('toggle-discord-rpc', (_event, enable) => {
    rpcEnabled = enable;
    if (enable) initDiscordRPC();
    else destroyDiscordRPC();
});

ipcMain.on('update-discord-rpc', (_event, data) => {
    if (data) setActivity(data.state, data.details);
});

function sendLogToUI(message, type = 'normal') {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('launcher-log', { message, type });

        let status = 'downloading';
        if (type === 'success' || message.includes('Game successfully launched')) status = 'running';
        if (type === 'error') status = 'error';

        let percentMatch = message.match(/(\d+(?:\.\d+)?)%/);
        let progress = percentMatch ? parseFloat(percentMatch[1]) : 50;

        mainWindow.webContents.send('launch-status', { msg: message, status, progress });
        mainWindow.webContents.send('launcher-status', message);
    }
    console.log(`[${type.toUpperCase()}] ${message}`);
}

async function downloadFile(url, dest, taskName = 'Installer') {
    return new Promise(async (resolve, reject) => {
        try {
            const response = await axios({ url, method: 'GET', responseType: 'stream' });
            const totalLength = response.headers['content-length'];
            let downloaded = 0;
            const writer = fs.createWriteStream(dest);

            response.data.on('data', (chunk) => {
                downloaded += chunk.length;
                if (totalLength) {
                    const percent = ((downloaded / totalLength) * 100).toFixed(1);
                    sendLogToUI(`Downloading ${taskName}: ${percent}%`, 'download');
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('launcher-progress', {
                            task: downloaded,
                            total: totalLength,
                            type: 'download'
                        });
                    }
                }
            });

            response.data.pipe(writer);
            writer.on('finish', () => resolve(true));
            writer.on('error', reject);
        } catch (err) {
            reject(err);
        }
    });
}

async function ensureJava(gameVersion) {
    let javaTarget = 'java8';
    const match = gameVersion.match(/1\.(\d+)(?:\.(\d+))?/);
    if (match) {
        const minor = parseInt(match[1]);
        const patch = parseInt(match[2] || '0');
        if (minor >= 21 || (minor === 20 && patch >= 5)) javaTarget = 'java21';
        else if (minor >= 17) javaTarget = 'java17';
    }

    if (process.platform !== 'win32') return undefined;

    const runtimesPath = path.join(runtimesDir, javaTarget);
    const javaExe = path.join(runtimesPath, 'bin', 'java.exe');

    if (fs.existsSync(javaExe)) return javaExe;

    const urls = {
        java21: 'https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.4%2B7/OpenJDK21U-jre_x64_windows_hotspot_21.0.4_7.zip',
        java17: 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.12%2B7/OpenJDK17U-jre_x64_windows_hotspot_17.0.12_7.zip',
        java8: 'https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u422-b05/OpenJDK8U-jre_x64_windows_hotspot_8u422b05.zip'
    };

    const zipPath = path.join(runtimesDir, `${javaTarget}.zip`);
    const tempDir = path.join(runtimesDir, `${javaTarget}_temp`);

    sendLogToUI(`Java ${javaTarget.replace('java', '')} is missing! Downloading automatically...`, 'info');
    await downloadFile(urls[javaTarget], zipPath, `Java ${javaTarget.replace('java', '')}`);

    sendLogToUI(`Extracting Java runtime... Please wait.`, 'info');
    try {
        await extract(zipPath, { dir: tempDir });
        const extractedFolders = fs.readdirSync(tempDir);
        fs.renameSync(path.join(tempDir, extractedFolders[0]), runtimesPath);
        fs.rmSync(tempDir, { recursive: true, force: true });
        fs.unlinkSync(zipPath);

        sendLogToUI(`Java installed successfully!`, 'success');
        return javaExe;
    } catch (err) {
        sendLogToUI(`Failed to install Java: ${err.message}`, 'error');
        return undefined;
    }
}

ipcMain.handle('get-local-versions', async () => {
    const versionsPath = path.join(rootPath, 'versions');
    try {
        if (fs.existsSync(versionsPath)) {
            const files = fs.readdirSync(versionsPath, { withFileTypes: true });
            return files.filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);
        }
        return [];
    } catch (err) {
        console.error('Failed to read versions:', err);
        return [];
    }
});

ipcMain.on('ms-login', async (event, lang = 'en') => {
    const isKm = lang === 'km';
    try {
        event.reply('ms-login-status', { 
            status: 'loading', 
            msg: isKm ? 'កំពុងបើកផ្ទាំងចូលគណនី Microsoft...' : 'Opening Microsoft Login...' 
        });

        const AuthClass = msmc.Auth || (msmc.default && msmc.default.Auth) || (typeof msmc === 'function' ? msmc : null);
        let mclcAuthResult = null;
        let playerName = 'Microsoft Player';
        let playerId = Date.now().toString();

        if (AuthClass && typeof AuthClass === 'function') {
            const authManager = new AuthClass('select_account');
            const xboxManager = await authManager.launch('electron');
            event.reply('ms-login-status', { 
                status: 'loading', 
                msg: isKm ? 'កំពុងទាញយក Minecraft Token...' : 'Getting Minecraft Token...' 
            });
            const token = await xboxManager.getMinecraft();
            
            mclcAuthResult = typeof token.mclc === 'function' ? token.mclc() : (token.mclc || token);
            playerName = mclcAuthResult.name || (token.profile && token.profile.name) || playerName;
            playerId = mclcAuthResult.uuid || mclcAuthResult.id || playerId;
        } else if (typeof msmc.fastLaunch === 'function') {
            const result = await msmc.fastLaunch('electron', (update) => {
                event.reply('ms-login-status', { 
                    status: 'loading', 
                    msg: update.message || (isKm ? 'កំពុងផ្ទៀងផ្ទាត់...' : 'Authenticating...') 
                });
            });
            if (msmc.errorCheck && msmc.errorCheck(result)) {
                throw new Error(result.reason || (isKm ? 'ការផ្ទៀងផ្ទាត់មិនជោគជ័យ' : 'Authentication failed'));
            }
            mclcAuthResult = typeof result.mclc === 'function' ? result.mclc() : (result.mclc || result);
            playerName = mclcAuthResult.name || (result.profile && result.profile.name) || playerName;
            playerId = mclcAuthResult.uuid || mclcAuthResult.id || playerId;
        } else {
            throw new Error(isKm ? 'MSMC library ដំណើរការមិនបានសម្រេច។' : 'MSMC library initialization failed.');
        }

        if (mclcAuthResult) {
            event.reply('ms-login-status', {
                status: 'success',
                account: {
                    id: playerId,
                    name: playerName,
                    type: 'microsoft',
                    mclcAuth: mclcAuthResult
                }
            });
        } else {
            throw new Error(isKm ? 'មិនអាចទាញយក Minecraft Token បានទេ។' : 'Failed to get Minecraft token.');
        }
    } catch (error) {
        console.error('MS Login Error:', error);
        event.reply('ms-login-status', { 
            status: 'error', 
            msg: error.message || (isKm ? 'ការចូលគណនីបានបរាជ័យ' : 'Login failed') 
        });
    }
});

ipcMain.handle('login-microsoft', async () => {
    try {
        const AuthClass = msmc.Auth || (msmc.default && msmc.default.Auth) || (typeof msmc === 'function' ? msmc : null);
        if (AuthClass && typeof AuthClass === 'function') {
            const authManager = new AuthClass('select_account');
            const xboxManager = await authManager.launch('electron');
            const token = await xboxManager.getMinecraft();
            return {
                success: true,
                profile: typeof token.mclc === 'function' ? token.mclc() : (token.mclc || token)
            };
        } else if (typeof msmc.fastLaunch === 'function') {
            const result = await msmc.fastLaunch('electron');
            return {
                success: true,
                profile: typeof result.mclc === 'function' ? result.mclc() : (result.mclc || result)
            };
        }
        return { success: false, error: 'MSMC not initialized' };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.on('cancel-launch', () => {
    isLaunchAborted = true;
    sendLogToUI('Launch sequence cancelled by user.', 'warning');
    setActivity('In Launcher', 'Ready to play');
});

ipcMain.on('launch-game', async (event, data) => {
    isLaunchAborted = false;
    const username = data.username || 'Player';
    const version = data.version || '1.20.4';
    const maxMem = data.ram ? `${data.ram}G` : (data.maxRam || '4G');
    const minMem = data.minRam || '2G';
    const authData = data.mclcAuth || data.msAuthObj;
    const isOffline = data.accountType !== 'microsoft' && !data.isMicrosoft;
    const profileId = data.profileId || 'default';

    const instanceDir = path.join(rootPath, 'instances', profileId.replace(/[^a-zA-Z0-9]/g, '_'));
    if (!fs.existsSync(instanceDir)) fs.mkdirSync(instanceDir, { recursive: true });

    let folderVersion = version;
    if (version.startsWith('Release ')) folderVersion = version.replace('Release ', '');
    const cleanVersion = folderVersion.replace(/^(Fabric|Forge|OptiFine)\s*/i, '').trim();
    const lowerVersion = folderVersion.toLowerCase();

    sendLogToUI(`Preparing to launch LONGVEKMC Launcher...`, 'system');
    sendLogToUI(`Player: ${username} | Version: ${folderVersion} | RAM: ${maxMem}`, 'system');
    setActivity(`In Game: ${folderVersion}`, `Playing as ${username}`);

    try {
        let authObj;
        if (isOffline) {
            authObj = Authenticator.getAuth(username);
        } else {
            if (!authData) throw new Error('Session expired! Please re-login.');
            authObj = authData;
        }

        let opts = {
            authorization: authObj,
            root: rootPath,
            overrides: {
                gameDirectory: instanceDir
            },
            version: { number: cleanVersion, type: 'release' },
            memory: { max: maxMem, min: minMem },
            customArgs: data.customArgs || []
        };

        let useJavaPath = await ensureJava(cleanVersion);
        if (useJavaPath) {
            opts.javaPath = useJavaPath;
            sendLogToUI(`Using optimized Java Runtime: ${useJavaPath}`, 'system');
        }

        if (lowerVersion.includes('fabric')) {
            sendLogToUI(`Fabric detected! Preparing Fabric Auto-Loader...`, 'system');
            opts.fabric = { build: 'latest' };
        } else if (lowerVersion.includes('forge')) {
            sendLogToUI(`Forge detected! Initializing Forge files...`, 'system');
            opts.version.custom = folderVersion;
        } else {
            opts.version.custom = folderVersion;
        }

        let hasGameStarted = false;

        launcher.on('debug', (e) => console.log(`[MCLC]: ${e}`));

        launcher.on('data', () => {
            if (!hasGameStarted) {
                hasGameStarted = true;
                sendLogToUI('Game successfully launched!', 'success');
            }
        });

        launcher.on('progress', (e) => {
            let percent = 0;
            if (e.total && e.total > 0) {
                percent = ((e.task / e.total) * 100).toFixed(1);
            }
            if (['download', 'assets', 'natives', 'classes'].includes(e.type)) {
                sendLogToUI(`Downloading ${e.type.toUpperCase()} (${percent}%)...`, 'download');
            } else if (e.task % 50 === 0 || e.task === e.total) {
                sendLogToUI(`Processing Game Files: ${percent}%`, 'info');
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('launcher-progress', e);
            }
        });

        launcher.on('close', (code) => {
            sendLogToUI(`Game closed (Code: ${code})`, 'warning');
            setActivity('In Launcher', 'Ready to play...');
            event.reply('launch-status', { msg: 'Game Closed', progress: 0, status: 'stopped' });
            event.reply('game-closed', code);
        });

        if (isLaunchAborted) {
            sendLogToUI('Launch aborted before start.', 'warning');
            return;
        }

        sendLogToUI(`Initializing Launch Sequence in [${instanceDir}]...`, 'info');
        await launcher.launch(opts);
    } catch (error) {
        sendLogToUI(`Launch Error: ${error.message}`, 'error');
        console.error('CRITICAL LAUNCH ERROR:', error);
        setActivity('In Launcher', 'Error launching game.');
    }
});

ipcMain.handle('get-installed-content', async () => {
    const readDirSafe = (dirPath) => {
        try {
            if (!fs.existsSync(dirPath)) return [];
            return fs.readdirSync(dirPath).map(file => {
                const fullPath = path.join(dirPath, file);
                const stats = fs.statSync(fullPath);
                return {
                    name: file,
                    sizeMb: (stats.size / (1024 * 1024)).toFixed(1),
                    isEnabled: !file.endsWith('.disabled')
                };
            });
        } catch {
            return [];
        }
    };

    return {
        mods: readDirSafe(modsDir),
        resourcePacks: readDirSafe(resourcePacksDir),
        shaderPacks: readDirSafe(shaderPacksDir)
    };
});

ipcMain.on('install-mod', async (event, data) => {
    try {
        let subFolder = 'mods';
        if (data.type === 'resourcepack' || data.type === 'resource') subFolder = 'resourcepacks';
        if (data.type === 'shader' || data.type === 'shaderpack') subFolder = 'shaderpacks';

        const targetDir = path.join(rootPath, subFolder);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

        const destPath = path.join(targetDir, data.fileName);
        await downloadFile(data.downloadUrl, destPath, `Addon: ${data.fileName}`);
        event.reply('mod-installed', data.modName || data.fileName);
    } catch (error) {
        console.error(`Failed to install addon:`, error);
    }
});

ipcMain.handle('delete-content-file', async (_event, { category, fileName }) => {
    try {
        let targetDir = modsDir;
        if (category === 'resource' || category === 'resourcepack') targetDir = resourcePacksDir;
        if (category === 'shader' || category === 'shaderpack') targetDir = shaderPacksDir;

        const filePath = path.join(targetDir, fileName);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return { success: true };
        }
        return { success: false, error: 'File not found' };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.on('delete-mod', (event, data) => {
    try {
        let subFolder = data.type === 'resourcepack' ? 'resourcepacks' : (data.type === 'shader' ? 'shaderpacks' : 'mods');
        const targetPath = path.join(rootPath, subFolder, data.filename || data.fileName);
        if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
            console.log(`Deleted file: ${targetPath}`);
        }
    } catch (error) {
        console.error(`Failed to delete mod:`, error);
    }
});

ipcMain.handle('toggle-content-file', async (_event, { category, fileName, enable }) => {
    try {
        let targetDir = modsDir;
        if (category === 'resource' || category === 'resourcepack') targetDir = resourcePacksDir;
        if (category === 'shader' || category === 'shaderpack') targetDir = shaderPacksDir;

        const oldPath = path.join(targetDir, fileName);
        let newName = enable ? fileName.replace('.disabled', '') : (fileName.endsWith('.disabled') ? fileName : `${fileName}.disabled`);
        const newPath = path.join(targetDir, newName);

        if (fs.existsSync(oldPath)) {
            fs.renameSync(oldPath, newPath);
            return { success: true, newFileName: newName };
        }
        return { success: false, error: 'File not found' };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.on('toggle-mod', (_event, data) => {
    try {
        let subFolder = data.type === 'resourcepack' ? 'resourcepacks' : (data.type === 'shader' ? 'shaderpacks' : 'mods');
        const basePath = path.join(rootPath, subFolder, data.filename);
        if (data.enable && fs.existsSync(basePath + '.disabled')) {
            fs.renameSync(basePath + '.disabled', basePath);
        } else if (!data.enable && fs.existsSync(basePath)) {
            fs.renameSync(basePath, basePath + '.disabled');
        }
    } catch (err) {
        console.error('Failed to toggle mod:', err);
    }
});

ipcMain.handle('add-custom-content-files', async (_event, category) => {
    let targetDir = modsDir;
    let fileFilters = [{ name: 'Mods (.jar)', extensions: ['jar'] }];

    if (category === 'resource' || category === 'resourcepack') {
        targetDir = resourcePacksDir;
        fileFilters = [{ name: 'Resource Packs (.zip)', extensions: ['zip'] }];
    } else if (category === 'shader' || category === 'shaderpack') {
        targetDir = shaderPacksDir;
        fileFilters = [{ name: 'Shaders (.zip)', extensions: ['zip'] }];
    }

    const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Custom Files to Install',
        properties: ['openFile', 'multiSelections'],
        filters: fileFilters
    });

    if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
    }

    try {
        result.filePaths.forEach(sourcePath => {
            const destPath = path.join(targetDir, path.basename(sourcePath));
            fs.copyFileSync(sourcePath, destPath);
        });
        return { success: true, count: result.filePaths.length };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.on('open-game-folder', (_event, subFolder) => {
    let targetPath = rootPath;
    if (subFolder === 'mods') targetPath = modsDir;
    else if (subFolder === 'resourcepacks') targetPath = resourcePacksDir;
    else if (subFolder === 'shaderpacks') targetPath = shaderPacksDir;
    shell.openPath(targetPath);
});

ipcMain.on('open-profile-folder', (_event, profileId) => {
    const instanceDir = path.join(rootPath, 'instances', (profileId || 'default').replace(/[^a-zA-Z0-9]/g, '_'));
    if (!fs.existsSync(instanceDir)) fs.mkdirSync(instanceDir, { recursive: true });
    shell.openPath(instanceDir);
});

ipcMain.on('apply-fps-boost', (_event, profileId) => {
    try {
        const instanceDir = path.join(rootPath, 'instances', (profileId || 'default').replace(/[^a-zA-Z0-9]/g, '_'));
        const profileModsDir = path.join(instanceDir, 'mods');
        if (!fs.existsSync(profileModsDir)) fs.mkdirSync(profileModsDir, { recursive: true });
        console.log(`[FPS Boost] Prepared instance folder for boost: ${instanceDir}`);
    } catch (err) {
        console.error('FPS Boost failed:', err);
    }
});

ipcMain.handle('submit-bug-report', async (_event, reportData) => {
    try {
        console.log('[Feedback/Bug Report Received]:', reportData);
        return { success: true };
    } catch (error) {
        console.error('Bug report error:', error);
        return { success: true };
    }
});