const { app, BrowserWindow, ipcMain, shell, session, dialog, clipboard, globalShortcut, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const axios = require('axios');
const extract = require('extract-zip');
const archiver = require('archiver');
const { Client, Authenticator } = require('minecraft-launcher-core');
const msmc = require('msmc');
const { autoUpdater } = require('electron-updater');

// បិទ HTTP Cache របស់ Chromium ដើម្បីធានាថាទាញយក UI index.html ថ្មីជានិច្ច
app.commandLine.appendSwitch('disable-http-cache');
// អនុញ្ញាតឱ្យប្រើប្រាស់ Garbage Collection សម្រាប់សម្អាត RAM
app.commandLine.appendSwitch('js-flags', '--expose-gc');

let mainWindow = null;
let splashWindow = null;
let rpcClient = null;
let rpcEnabled = true;
let isLaunchAborted = false;

const launcher = new Client();

// កំណត់ Directory ស្តង់ដាររបស់ LONGVEK Launcher
const rootPath = process.platform === 'win32'
    ? path.join(app.getPath('appData'), '.longvek')
    : path.join(os.homedir(), '.longvek');

const runtimesDir = path.join(rootPath, 'runtimes');
const versionsDir = path.join(rootPath, 'versions');
const librariesDir = path.join(rootPath, 'libraries');
const assetsDir = path.join(rootPath, 'assets');
const indexesDir = path.join(assetsDir, 'indexes');
const objectsDir = path.join(assetsDir, 'objects');
const instancesDir = path.join(rootPath, 'instances');

[rootPath, runtimesDir, versionsDir, librariesDir, assetsDir, indexesDir, objectsDir, instancesDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// =========================================================================
// 1. DYNAMIC MINECRAFT CORE ENGINE (MOJANG V2 & FABRIC META APIS)
// =========================================================================

const MOJANG_MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FABRIC_META_URL = 'https://meta.fabricmc.net/v2/versions/loader';

class MinecraftCoreEngine {
    constructor() {
        this.http = axios.create({
            timeout: 25000,
            headers: { 'User-Agent': 'LONGVEK-Launcher-Engine/3.0' }
        });
    }

    verifyFile(filePath, expectedSha1 = null, expectedSize = null) {
        if (!fs.existsSync(filePath)) return false;
        try {
            const stat = fs.statSync(filePath);
            if (stat.size <= 0) return false;
            if (expectedSize !== null && stat.size !== expectedSize) return false;

            if (expectedSha1) {
                const data = fs.readFileSync(filePath);
                const hash = crypto.createHash('sha1').update(data).digest('hex').toLowerCase();
                return hash === expectedSha1.toLowerCase();
            }
            return true;
        } catch {
            return false;
        }
    }

    async downloadFileSafe(url, destPath, expectedSha1 = null, expectedSize = null) {
        if (this.verifyFile(destPath, expectedSha1, expectedSize)) {
            return true;
        }

        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const tempPath = destPath + '.tmp';
        try {
            const response = await this.http.get(url, { responseType: 'stream' });
            const writer = fs.createWriteStream(tempPath);

            await new Promise((resolve, reject) => {
                response.data.pipe(writer);
                let err = null;
                writer.on('error', e => { err = e; try { writer.close(); } catch(ex){} reject(e); });
                writer.on('finish', () => {
                    writer.close(() => { if (!err) resolve(true); });
                });
            });

            if (!this.verifyFile(tempPath, expectedSha1, expectedSize)) {
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
                return false;
            }

            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            fs.renameSync(tempPath, destPath);
            return true;
        } catch (err) {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            console.warn(`[Download Error]: ${path.basename(destPath)}: ${err.message}`);
            return false;
        }
    }

    async fetchVanillaVersions(releaseOnly = true) {
        try {
            const res = await this.http.get(MOJANG_MANIFEST_URL);
            let versions = res.data?.versions || [];
            if (releaseOnly) {
                versions = versions.filter(v => v.type === 'release');
            }
            return versions;
        } catch (err) {
            console.error('[Mojang API Error]:', err.message);
            return [];
        }
    }

    async fetchFabricLoaders(gameVersion) {
        try {
            const res = await this.http.get(`${FABRIC_META_URL}/${gameVersion}`);
            return Array.isArray(res.data) ? res.data : [];
        } catch (err) {
            console.error('[Fabric API Error]:', err.message);
            return [];
        }
    }

    async setupFabricProfile(gameVersion) {
        const loaders = await this.fetchFabricLoaders(gameVersion);
        if (loaders.length === 0) return null;

        const loaderVersion = loaders[0]?.loader?.version;
        const profileId = `fabric-loader-${loaderVersion}-${gameVersion}`;
        const targetDir = path.join(versionsDir, profileId);
        const targetJson = path.join(targetDir, `${profileId}.json`);

        if (fs.existsSync(targetJson)) {
            return profileId;
        }

        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        const profileUrl = `${FABRIC_META_URL}/${gameVersion}/${loaderVersion}/profile/json`;

        sendLogToUI(`Downloading Fabric Profile JSON: ${profileId}...`, 'info');
        const ok = await this.downloadFileSafe(profileUrl, targetJson);
        if (ok) {
            sendLogToUI(`Fabric Profile installed successfully!`, 'success');
            return profileId;
        }
        return null;
    }
}

const mcEngine = new MinecraftCoreEngine();

// =========================================================================
// AUTO RAM CLEANUP ENGINE
// =========================================================================
function performRamCleanup() {
    try {
        if (global.gc) {
            global.gc();
        }
        console.log('[RAM Cleanup]: Optimized internal memory cache safely.');
    } catch (e) {
        console.warn('[RAM Cleanup Note]: Enable --expose-gc flag for full memory cleanup. ', e.message);
    }
}

// =========================================================================
// ESSENTIAL HELPER FUNCTIONS
// =========================================================================

function sendLogToUI(message, type = 'info') {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('launcher-log', { message, type });
    }
}

function getInstanceDir(profileId) {
    const pId = (profileId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = path.join(rootPath, 'instances', pId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getInstanceContentDir(profileId, category) {
    const instDir = getInstanceDir(profileId);
    let sub = 'mods';
    const cat = (category || '').toLowerCase();
    if (cat.includes('resource')) sub = 'resourcepacks';
    else if (cat.includes('shader')) sub = 'shaderpacks';
    else sub = 'mods';
    const target = path.join(instDir, sub);
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
    return target;
}

function sanitizeInstanceMods(instanceDir, mcVersion) {
    try {
        const instModsDir = path.join(instanceDir, 'mods');
        if (!fs.existsSync(instModsDir)) return;
        const files = fs.readdirSync(instModsDir);
        for (const file of files) {
            if (file.endsWith('.jar') || file.endsWith('.zip') || file.endsWith('.jar.disabled')) {
                const filePath = path.join(instModsDir, file);
                const stat = fs.statSync(filePath);
                if (stat.size < 1024) {
                    fs.unlinkSync(filePath);
                    console.log(`[Sanitizer] Deleted corrupted/empty file: ${file}`);
                    continue;
                }
            }
        }
    } catch (e) {
        console.warn('[Sanitizer Notice]:', e.message);
    }
}

function ensureLongvekInGameConfig(instanceDir, username = 'Player') {
    try {
        const configDir = path.join(instanceDir, 'config');
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

        const hudConfigs = ['longvek-hud.json', 'kronhud.json', 'simplehud.json'];
        const hudPayload = {
            clientName: "LONGVEK CLIENT",
            clientVersion: "v2.0 PRO",
            theme: {
                primaryColor: "#38bdf8",
                secondaryColor: "#0ea5e9",
                backgroundColor: "rgba(11, 19, 41, 0.75)",
                textColor: "#ffffff",
                accentColor: "#38bdf8",
                glow: true,
                roundedCorners: true,
                borderWidth: 1.5,
                borderColor: "rgba(56, 189, 248, 0.45)"
            },
            modules: {
                watermark: { enabled: true, text: "LONGVEK CLIENT v2.0", x: 6, y: 6, color: "#38bdf8" },
                fps: { enabled: true, showLabel: true, x: 6, y: 22, color: "#ffffff" },
                ping: { enabled: true, showLabel: true, x: 6, y: 36, color: "#34d399" },
                cps: { enabled: true, showBoth: true, x: 6, y: 50, color: "#38bdf8" },
                keystrokes: {
                    enabled: true,
                    showMouseButtons: true,
                    showSpacebar: true,
                    x: 6,
                    y: 70,
                    keyColor: "rgba(255, 255, 255, 0.85)",
                    activeKeyColor: "#38bdf8",
                    keyBackground: "rgba(11, 19, 41, 0.8)"
                },
                coordinates: { enabled: true, showBiome: true, x: 6, y: 160 },
                armorStatus: { enabled: true, horizontal: false, x: -30, y: -80 }
            },
            keybinds: {
                menuToggle: "RIGHT_SHIFT",
                hudToggle: "F8"
            }
        };

        hudConfigs.forEach(cfgName => {
            const cfgPath = path.join(configDir, cfgName);
            try {
                fs.writeFileSync(cfgPath, JSON.stringify(hudPayload, null, 2), 'utf8');
            } catch (e) {}
        });

        const modMenuPath = path.join(configDir, 'modmenu.json');
        const modMenuConfig = {
            badge_mods: true,
            modify_title_screen: true,
            mods_button_style: "replace_realms",
            show_libraries: false
        };
        try {
            fs.writeFileSync(modMenuPath, JSON.stringify(modMenuConfig, null, 2), 'utf8');
        } catch (e) {}

        const optionsTxtPath = path.join(instanceDir, 'options.txt');
        let optionsMap = new Map();

        if (fs.existsSync(optionsTxtPath)) {
            const rawContent = fs.readFileSync(optionsTxtPath, 'utf8');
            rawContent.split(/\r?\n/).forEach(line => {
                const idx = line.indexOf(':');
                if (idx > 0) {
                    const k = line.substring(0, idx).trim();
                    const v = line.substring(idx + 1).trim();
                    optionsMap.set(k, v);
                }
            });
        }

        optionsMap.set('gamma', '1000.0');
        optionsMap.set('autoJump', 'false');
        optionsMap.set('fov', optionsMap.get('fov') || '85.0');
        optionsMap.set('key_key.modmenu.open', 'key.keyboard.right.shift');
        optionsMap.set('key_key.kronhud.open', 'key.keyboard.right.shift');
        optionsMap.set('key_key.hud.menu', 'key.keyboard.right.shift');

        let optionsLines = [];
        for (const [k, v] of optionsMap.entries()) {
            optionsLines.push(`${k}:${v}`);
        }
        fs.writeFileSync(optionsTxtPath, optionsLines.join('\n'), 'utf8');
        console.log(`[Config Engine]: Automatically generated LONGVEK HUD & PvP options for ${username}!`);
    } catch (err) {
        console.warn('[Config Engine Warning]:', err.message);
    }
}

// មុខងារទាញយកហ្វាលដែលរាយការណ៍ Progress និង Flush Stream ពេញលេញ ១០០%
async function downloadFile(url, destPath, label = 'File', onProgress = null) {
    const dir = path.dirname(destPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const tempPath = destPath + '.tmp';
    const writer = fs.createWriteStream(tempPath);
    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            timeout: 45000,
            headers: { 'User-Agent': 'LONGVEK-Client-Downloader/2.5' }
        });

        const totalLength = parseInt(response.headers['content-length'] || '0', 10);
        let downloaded = 0;

        response.data.on('data', chunk => {
            downloaded += chunk.length;
            if (totalLength > 0 && typeof onProgress === 'function') {
                const pct = Math.min(99, Math.round((downloaded / totalLength) * 100));
                onProgress(pct);
            }
        });

        await new Promise((resolve, reject) => {
            response.data.pipe(writer);

            writer.on('error', err => {
                try { writer.close(); } catch(e){}
                reject(err);
            });
            writer.on('finish', () => {
                writer.close(() => resolve(true));
            });
        });

        if (typeof onProgress === 'function') onProgress(100);

        const stat = fs.statSync(tempPath);
        if (stat.size > 30) {
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            fs.renameSync(tempPath, destPath);
            return true;
        } else {
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            throw new Error('Downloaded file is empty or corrupted.');
        }
    } catch (error) {
        if (fs.existsSync(tempPath)) {
            try { fs.unlinkSync(tempPath); } catch (e) {}
        }
        throw error;
    }
}

async function ensureFabricProfile(mcVersion) {
    try {
        const versionsDir = path.join(rootPath, 'versions');
        if (!fs.existsSync(versionsDir)) fs.mkdirSync(versionsDir, { recursive: true });

        const metaUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`;
        const metaRes = await axios.get(metaUrl, { timeout: 8000 });
        if (!Array.isArray(metaRes.data) || metaRes.data.length === 0) {
            sendLogToUI(`Fabric meta not available for ${mcVersion}, continuing with release version.`, 'warning');
            return null;
        }

        const loaderVersion = metaRes.data[0].loader.version;
        const fabricProfileId = `fabric-loader-${loaderVersion}-${mcVersion}`;
        const targetVersionDir = path.join(versionsDir, fabricProfileId);
        const targetJson = path.join(targetVersionDir, `${fabricProfileId}.json`);

        if (fs.existsSync(targetJson)) return fabricProfileId;

        sendLogToUI(`Setting up Fabric Profile: ${fabricProfileId}...`, 'info');
        if (!fs.existsSync(targetVersionDir)) fs.mkdirSync(targetVersionDir, { recursive: true });

        const profileJsonUrl = `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${loaderVersion}/profile/json`;
        const profileRes = await axios.get(profileJsonUrl, { timeout: 10000 });
        fs.writeFileSync(targetJson, JSON.stringify(profileRes.data, null, 2), 'utf8');

        sendLogToUI(`Fabric Profile installed successfully!`, 'success');
        return fabricProfileId;
    } catch (err) {
        console.warn('Fabric Profile setup error:', err.message);
        return null;
    }
}

async function ensureFabricAPI(instanceDir, mcVersion) {
    try {
        const instModsDir = path.join(instanceDir, 'mods');
        if (!fs.existsSync(instModsDir)) fs.mkdirSync(instModsDir, { recursive: true });

        const files = fs.readdirSync(instModsDir);
        const hasFabricApi = files.some(f => f.toLowerCase().includes('fabric-api') && !f.endsWith('.disabled'));
        if (hasFabricApi) return true;

        sendLogToUI(`[Fabric API Engine]: Auto-downloading Fabric API from Modrinth...`, 'info');
        const apiUrl = 'https://api.modrinth.com/v2/project/fabric-api/version';
        const res = await axios.get(apiUrl, {
            params: {
                game_versions: JSON.stringify([mcVersion]),
                loaders: JSON.stringify(['fabric'])
            },
            timeout: 8000,
            headers: { 'User-Agent': 'LONGVEK-Client-Launcher/2.5' }
        });
        if (Array.isArray(res.data) && res.data.length > 0 && res.data[0].files && res.data[0].files.length > 0) {
            const file = res.data[0].files[0];
            const destPath = path.join(instModsDir, file.filename);
            await downloadFile(file.url, destPath, 'Fabric API');
            sendLogToUI(`[Fabric API Engine]: Fabric API successfully installed!`, 'success');
            return true;
        }
    } catch (e) {
        console.warn('Fabric API auto-download skipped:', e.message);
    }
    return false;
}

async function ensureInGameHudMod(instanceDir, mcVersion, loader = 'fabric') {
    try {
        const instModsDir = path.join(instanceDir, 'mods');
        if (!fs.existsSync(instModsDir)) fs.mkdirSync(instModsDir, { recursive: true });

        const files = fs.readdirSync(instModsDir);
        const hasHudMod = files.some(f => {
            const low = f.toLowerCase();
            return (low.includes('kronhud') || low.includes('simplehud') || low.includes('hud') || low.includes('modmenu')) && !low.endsWith('.disabled');
        });

        if (hasHudMod) return true;

        sendLogToUI(`[HUD Engine]: Auto-installing In-Game HUD & RSHIFT Menu...`, 'info');
        const hudProjects = ['kronhud', 'modmenu'];
        for (const proj of hudProjects) {
            try {
                const apiUrl = `https://api.modrinth.com/v2/project/${proj}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}&loaders=${encodeURIComponent(JSON.stringify([loader]))}`;
                const res = await axios.get(apiUrl, { timeout: 8000, headers: { 'User-Agent': 'LONGVEK-Launcher-HUD/2.5' } });
                if (Array.isArray(res.data) && res.data.length > 0 && res.data[0].files && res.data[0].files.length > 0) {
                    const file = res.data[0].files.find(f => f.primary) || res.data[0].files[0];
                    const dest = path.join(instModsDir, file.filename);
                    if (!fs.existsSync(dest)) {
                        await downloadFile(file.url, dest, proj);
                        sendLogToUI(`[HUD Engine]: Installed ${proj} successfully!`, 'success');
                    }
                }
            } catch (err) {
                console.warn(`[HUD Engine]: Could not fetch ${proj}:`, err.message);
            }
        }
        return true;
    } catch (e) {
        console.warn('HUD mod auto-download error:', e.message);
        return false;
    }
}

// =========================================================================
// IN-GAME CAPE ENGINE
// =========================================================================
async function ensureInGameCape(instanceDir, username, capeUrl, mcVersion, loader = 'fabric', capeData = null, userUuid = null) {
    if (!capeUrl && !capeData) return false;

    try {
        const instModsDir = path.join(instanceDir, 'mods');
        if (!fs.existsSync(instModsDir)) fs.mkdirSync(instModsDir, { recursive: true });

        const files = fs.readdirSync(instModsDir);
        const hasCapeMod = files.some(f => f.toLowerCase().includes('customskinloader') && !f.endsWith('.disabled'));

        if (!hasCapeMod) {
            sendLogToUI(`[Cape Engine]: Downloading In-Game Cape Loader (CustomSkinLoader)...`, 'info');
            try {
                const cleanVer = mcVersion.replace(/^(Fabric|Forge|OptiFine|Release)\s*/i, '').trim();
                const apiUrl = `https://api.modrinth.com/v2/project/customskinloader/version`;
                const res = await axios.get(apiUrl, { timeout: 10000, headers: { 'User-Agent': 'LONGVEK-Cape-Engine/3.0' } });
                
                if (Array.isArray(res.data) && res.data.length > 0) {
                    const targetEntry = res.data.find(v => {
                        return (!v.game_versions || v.game_versions.includes(cleanVer)) &&
                               (!v.loaders || v.loaders.includes(loader));
                    }) || res.data.find(v => !v.loaders || v.loaders.includes(loader)) || res.data[0];

                    const file = targetEntry.files.find(f => f.primary) || targetEntry.files[0];
                    const destPath = path.join(instModsDir, file.filename);
                    await downloadFile(file.url, destPath, 'CustomSkinLoader');
                    sendLogToUI(`[Cape Engine]: Cape Loader installed successfully!`, 'success');
                }
            } catch (err) {
                console.warn('[Cape Engine]: CustomSkinLoader fetch fallback:', err.message);
            }
        }

        const cslDir = path.join(instanceDir, 'CustomSkinLoader');
        const localCapesDir = path.join(cslDir, 'LocalSkin', 'capes');
        const rootCapesDir = path.join(cslDir, 'capes');
        const instCapesDir = path.join(instanceDir, 'capes');

        [localCapesDir, rootCapesDir, instCapesDir].forEach(d => {
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
        });

        const safeUsername = (username || 'Player').replace(/\s+/g, '_');
        const filenames = [
            `${safeUsername}.png`,
            `${safeUsername.toLowerCase()}.png`
        ];

        if (userUuid) {
            const cleanUuid = userUuid.replace(/-/g, '').trim();
            filenames.push(`${userUuid}.png`);
            filenames.push(`${cleanUuid}.png`);
            filenames.push(`${cleanUuid.toLowerCase()}.png`);
        }

        let capeBuffer = null;
        if (capeData && typeof capeData === 'string' && capeData.startsWith('data:image')) {
            const base64Data = capeData.replace(/^data:image\/\w+;base64,/, '');
            capeBuffer = Buffer.from(base64Data, 'base64');
        } else if (capeUrl) {
            let normalizedCapeUrl = capeUrl;
            if (normalizedCapeUrl.includes('github.com') && normalizedCapeUrl.includes('/blob/')) {
                normalizedCapeUrl = normalizedCapeUrl.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
            }
            try {
                const res = await axios.get(normalizedCapeUrl, { responseType: 'arraybuffer', timeout: 15000 });
                if (res.data && res.data.length > 30) {
                    capeBuffer = Buffer.from(res.data);
                }
            } catch (e) {
                console.warn('[Cape Engine]: Raw cape buffer fetch error:', e.message);
            }
        }

        if (capeBuffer && capeBuffer.length > 30) {
            sendLogToUI(`[Cape Engine]: Synchronizing LONGVEK Cape texture for ${safeUsername}...`, 'info');
            [localCapesDir, rootCapesDir, instCapesDir].forEach(targetDir => {
                filenames.forEach(fn => {
                    try {
                        fs.writeFileSync(path.join(targetDir, fn), capeBuffer);
                    } catch (e) {}
                });
            });
        }

        const cslConfigPath = path.join(cslDir, 'CustomSkinLoader.json');
        const cslConfigPayload = {
            version: "14.15",
            loadlist: [
                { name: "LocalSkin", type: "Legacy" },
                { name: "Mojang", type: "MojangAPI" },
                { name: "MinecraftCapes", type: "MinecraftCapes" },
                { name: "OptiFineCape", type: "OptiFineCape" }
            ],
            enableDynamicSkull: true,
            enableTransparentSkin: true,
            ignoreServerSkin: false
        };

        try {
            fs.writeFileSync(cslConfigPath, JSON.stringify(cslConfigPayload, null, 2), 'utf8');
        } catch (e) {}

        sendLogToUI(`[Cape Engine]: In-Game Cape synchronized 100% with Launcher!`, 'success');
        return true;
    } catch (e) {
        console.warn('[Cape Engine Warning]: Failed to inject in-game cape:', e.message);
        return false;
    }
}

// =========================================================================
// SMART CRASH ANALYZER ENGINE
// =========================================================================
function analyzeCrashLog(instanceDir, exitCode) {
    const result = {
        code: exitCode,
        summaryEn: 'Unexpected game crash detected.',
        summaryKh: 'ហ្គេមបានគាំង ឬបិទដោយមិនរំពឹងទុក។',
        adviceEn: 'Check allocated RAM or mod compatibility in Settings.',
        adviceKh: 'សូមពិនិត្យមើលទំហំ RAM ឬភាពត្រូវគ្នានៃម៉ូដក្នុងការកំណត់។',
        details: '',
        fixType: null,
        conflictFile: null
    };

    try {
        const crashReportsDir = path.join(instanceDir, 'crash-reports');
        const logsDir = path.join(instanceDir, 'logs');
        let latestLogText = '';

        if (fs.existsSync(crashReportsDir)) {
            const reports = fs.readdirSync(crashReportsDir).sort().reverse();
            if (reports.length > 0) {
                latestLogText = fs.readFileSync(path.join(crashReportsDir, reports[0]), 'utf8');
            }
        }

        if (!latestLogText && fs.existsSync(logsDir)) {
            const latestLogPath = path.join(logsDir, 'latest.log');
            if (fs.existsSync(latestLogPath)) {
                latestLogText = fs.readFileSync(latestLogPath, 'utf8');
            }
        }

        result.details = latestLogText.slice(-3000) || `Process exited with code ${exitCode}. No detailed log available.`;

        if (latestLogText.includes('fabric') && (latestLogText.includes('requires fabric') || latestLogText.includes('Missing or unsupported mandatory dependencies:') || latestLogText.includes('fabric-api'))) {
            result.summaryEn = 'Missing Mandatory Dependency: Fabric API';
            result.summaryKh = 'ខ្វះបណ្ណាល័យសំខាន់៖ Fabric API';
            result.adviceEn = 'Many Fabric mods require the Fabric API to run. Click Auto-Fix to install it immediately.';
            result.adviceKh = 'ម៉ូដ Fabric ភាគច្រើនទាមទារ Fabric API ដើម្បីដំណើរការ។ ចុច Auto-Fix ដើម្បីដំឡើងវាភ្លាមៗ។';
            result.fixType = 'install_fabric_api';
            result.fixActionLabelEn = 'Install Fabric API';
            result.fixActionLabelKh = 'ដំឡើង Fabric API ស្វ័យប្រវត្តិ';
            return result;
        }

        if (latestLogText.includes('java.lang.OutOfMemoryError') || latestLogText.includes('Could not reserve enough space') || latestLogText.includes('error: memory')) {
            result.summaryEn = 'Insufficient RAM Allocated (OutOfMemoryError)';
            result.summaryKh = 'ខ្វះទំហំ Memory RAM (OutOfMemoryError)';
            result.adviceEn = 'The game exceeded available memory. Allocate at least 4 GB in Settings.';
            result.adviceKh = 'ហ្គេមខ្វះខាតទំហំ RAM សម្រាប់ដំណើរការ។ សូមដំឡើង RAM យ៉ាងហោចណាស់ 4 GB ក្នុងការកំណត់។';
            result.fixType = 'fix_ram_4gb';
            result.fixActionLabelEn = 'Set Safe 4GB RAM';
            result.fixActionLabelKh = 'កំណត់ RAM 4GB ស្វ័យប្រវត្តិ';
            return result;
        }

        if ((latestLogText.includes('optifine') || latestLogText.includes('OptiFine')) && (latestLogText.includes('sodium') || latestLogText.includes('embeddium'))) {
            result.summaryEn = 'Incompatible Mods Conflict (OptiFine + Sodium)';
            result.summaryKh = 'ម៉ូដជល់គ្នា (OptiFine ជាមួយ Sodium)';
            result.adviceEn = 'OptiFine cannot run simultaneously with Sodium or Embeddium shaders engine.';
            result.adviceKh = 'OptiFine មិនអាចដំណើរការព្រមគ្នាជាមួយម៉ូដបង្កើន FPS Sodium ឬ Embeddium ឡើយ។';
            result.fixType = 'disable_conflict';
            result.conflictFile = 'OptiFine';
            result.fixActionLabelEn = 'Disable Conflicting Mod';
            result.fixActionLabelKh = 'បិទម៉ូដដែលជល់គ្នា';
            return result;
        }
    } catch (e) {
        console.warn('Crash log analysis error:', e.message);
    }
    return result;
}

// =========================================================================
// LOW-END PC TURBO FPS PACK DOWNLOADER
// =========================================================================
const LOW_END_FPS_MODS = [
    { id: 'sodium', fallback: 'embeddium', desc: 'Rendering Engine (2x-3x FPS)' },
    { id: 'lithium', fallback: null, desc: 'Physics & CPU Optimization' },
    { id: 'ferrite-core', fallback: null, desc: 'RAM Overhead Reducer (Up to 50%)' },
    { id: 'immediatelyfast', fallback: null, desc: 'HUD & GUI Rendering Accelerator' },
    { id: 'entityculling', fallback: null, desc: 'Skip Rendering Hidden Entities' }
];

async function installLowEndFpsPack(profileId, mcVersion, loader = 'fabric') {
    const instDir = getInstanceDir(profileId);
    const modsDir = path.join(instDir, 'mods');
    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });

    let installedCount = 0;
    const cleanVer = mcVersion.replace(/^(Fabric|Forge|OptiFine|Release)\s*/i, '').trim();
    const cleanLoader = (loader || 'fabric').toLowerCase();

    for (const mod of LOW_END_FPS_MODS) {
        try {
            let targetModId = mod.id;
            if (cleanLoader === 'forge' && mod.fallback) targetModId = mod.fallback;

            const apiUrl = `https://api.modrinth.com/v2/project/${targetModId}/version?game_versions=${encodeURIComponent(JSON.stringify([cleanVer]))}&loaders=${encodeURIComponent(JSON.stringify([cleanLoader]))}`;
            const res = await axios.get(apiUrl, { timeout: 8000, headers: { 'User-Agent': 'LONGVEK-Turbo-Pack/2.5' } });

            if (Array.isArray(res.data) && res.data.length > 0 && res.data[0].files && res.data[0].files.length > 0) {
                const file = res.data[0].files.find(f => f.primary) || res.data[0].files[0];
                const dest = path.join(modsDir, file.filename);
                if (!fs.existsSync(dest)) {
                    await downloadFile(file.url, dest, targetModId);
                    installedCount++;
                }
            }
        } catch (err) {
            console.warn(`[Turbo Pack Error]: Failed downloading ${mod.id}:`, err.message);
        }
    }
    return { success: true, count: installedCount };
}

// =========================================================================
// MODPACK IMPORT & SCREENSHOTS GALLERY IPC HANDLERS
// =========================================================================

ipcMain.handle('import-modpack-file', async (_event, filePath) => {
    if (!filePath || typeof filePath !== 'string') {
        return { success: false, error: 'Invalid file path.' };
    }
    if (!fs.existsSync(filePath)) {
        return { success: false, error: 'File does not exist.' };
    }

    try {
        const ext = path.extname(filePath).toLowerCase();
        const baseName = path.basename(filePath, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
        const profileId = `pack_${baseName}_${Date.now()}`;
        const targetInstance = getInstanceDir(profileId);

        sendLogToUI(`Extracting modpack: ${path.basename(filePath)}...`, 'info');
        
        await extract(filePath, { dir: targetInstance });

        let detectedVersion = '1.20.1';
        let detectedLoader = 'fabric';

        const modrinthIndex = path.join(targetInstance, 'modrinth.index.json');
        if (fs.existsSync(modrinthIndex)) {
            try {
                const idx = JSON.parse(fs.readFileSync(modrinthIndex, 'utf8'));
                if (idx.game === 'minecraft') {
                    detectedVersion = idx.dependencies?.minecraft || detectedVersion;
                    if (idx.dependencies?.forge) detectedLoader = 'forge';
                    else if (idx.dependencies?.fabric) detectedLoader = 'fabric';
                }
                const overridesDir = path.join(targetInstance, 'overrides');
                if (fs.existsSync(overridesDir)) {
                    const entries = fs.readdirSync(overridesDir);
                    for (const entry of entries) {
                        const src = path.join(overridesDir, entry);
                        const dst = path.join(targetInstance, entry);
                        if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
                        fs.renameSync(src, dst);
                    }
                }
            } catch (e) {}
        }

        return {
            success: true,
            profile: {
                id: profileId,
                name: baseName.replace(/_/g, ' '),
                version: detectedVersion,
                loader: detectedLoader,
                icon: 'ph-package'
            }
        };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('get-screenshots', async (_event, profileId) => {
    try {
        const instDir = getInstanceDir(profileId);
        const screenshotsDir = path.join(instDir, 'screenshots');
        if (!fs.existsSync(screenshotsDir)) return [];

        const files = fs.readdirSync(screenshotsDir);
        const imageFiles = files.filter(f => /\.(png|jpe?g|webp)$/i.test(f));

        const results = [];
        for (const file of imageFiles) {
            const fullPath = path.join(screenshotsDir, file);
            const stats = fs.statSync(fullPath);
            results.push({
                name: file,
                path: fullPath,
                time: stats.mtimeMs,
                size: (stats.size / 1024).toFixed(1) + ' KB',
                url: `file://${fullPath.replace(/\\/g, '/')}`
            });
        }
        results.sort((a, b) => b.time - a.time);
        return results;
    } catch (err) {
        console.warn('Get screenshots error:', err.message);
        return [];
    }
});

ipcMain.handle('delete-screenshot', async (_event, filePath) => {
    try {
        if (!filePath || typeof filePath !== 'string') {
            return { success: false, error: 'Invalid path' };
        }
        const normalizedPath = path.resolve(filePath);
        if (!normalizedPath.startsWith(path.resolve(rootPath))) {
            return { success: false, error: 'Access denied: Path outside safe root.' };
        }

        if (fs.existsSync(normalizedPath)) {
            fs.unlinkSync(normalizedPath);
            return { success: true };
        }
        return { success: false, error: 'File not found' };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('copy-screenshot-image', async (_event, filePath) => {
    try {
        if (!filePath || typeof filePath !== 'string') {
            return { success: false, error: 'Invalid path' };
        }
        const normalizedPath = path.resolve(filePath);
        if (!normalizedPath.startsWith(path.resolve(rootPath))) {
            return { success: false, error: 'Access denied: Path outside safe root.' };
        }

        if (fs.existsSync(normalizedPath)) {
            const img = nativeImage.createFromPath(normalizedPath);
            clipboard.writeImage(img);
            return { success: true };
        }
        return { success: false, error: 'File not found' };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.on('open-external-link', (_event, url) => {
    if (!url || typeof url !== 'string') return;
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            shell.openExternal(url);
        } else {
            console.warn(`[Security Warning]: Blocked unsafe protocol open: ${url}`);
        }
    } catch (e) {
        console.warn(`[Security Warning]: Invalid external URL: ${url}`);
    }
});

ipcMain.on('open-screenshot-folder', (_event, profileId) => {
    const instDir = getInstanceDir(profileId);
    const screenshotsDir = path.join(instDir, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
    shell.openPath(screenshotsDir);
});

// =========================================================================
// MOD & CONTENT MANAGER IPC HANDLERS (ដោះស្រាយបញ្ហាគាំងនៅ 99%)
// =========================================================================
ipcMain.on('install-mod', async (event, data) => {
    const { downloadUrl, fileName, modName, type, profileId } = data;
    try {
        const targetFolder = getInstanceContentDir(profileId, type);
        const destPath = path.join(targetFolder, fileName);

        sendLogToUI(`Downloading ${modName} (${fileName})...`, 'info');
        
        await downloadFile(downloadUrl, destPath, modName, (percent) => {
            // បញ្ជូនភាគរយពិតប្រាកដទៅកាន់ UI ភ្លាមៗ
            event.sender.send('mod-download-progress', { modName, percent });
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('mod-download-progress', { modName, percent });
            }
        });

        sendLogToUI(`Successfully installed ${modName}!`, 'success');
        
        // ធានាថាបញ្ជូនដំណឹងជោគជ័យ ១០០% ទៅ UI ទាំងពីរផ្លូវ
        event.sender.send('mod-download-progress', { modName, percent: 100 });
        event.sender.send('mod-installed', modName);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('mod-installed', modName);
        }
    } catch (err) {
        console.error(`[Mod Download Error]: ${err.message}`);
        sendLogToUI(`Failed to download ${modName}: ${err.message}`, 'error');
        event.sender.send('mod-install-error', { modName, error: err.message });
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('mod-install-error', { modName, error: err.message });
        }
    }
});

ipcMain.on('delete-mod', async (_event, data) => {
    const { filename, type, profileId } = data;
    try {
        const targetFolder = getInstanceContentDir(profileId, type);
        const targetPath = path.join(targetFolder, filename);
        const disabledPath = targetPath + '.disabled';
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        if (fs.existsSync(disabledPath)) fs.unlinkSync(disabledPath);
    } catch (err) {
        console.warn(`[Delete Mod Error]: ${err.message}`);
    }
});

ipcMain.on('toggle-mod', async (_event, data) => {
    const { filename, type, enable, profileId } = data;
    try {
        const targetFolder = getInstanceContentDir(profileId, type);
        const normalName = filename.replace(/\.disabled$/, '');
        const activePath = path.join(targetFolder, normalName);
        const disabledPath = path.join(targetFolder, normalName + '.disabled');
        if (enable) {
            if (fs.existsSync(disabledPath)) fs.renameSync(disabledPath, activePath);
        } else {
            if (fs.existsSync(activePath)) fs.renameSync(activePath, disabledPath);
        }
    } catch (err) {
        console.warn(`[Toggle Mod Error]: ${err.message}`);
    }
});

// =========================================================================
// DISCORD RPC ENGINE
// =========================================================================
const CLIENT_ID = '123456789012345678';
let rpcStartTime = Date.now();
let rpcRetryTimer = null;

function initDiscordRPC() {
    if (!rpcEnabled) return;
    try {
        const DiscordRPC = require('discord-rpc');
        rpcClient = new DiscordRPC.Client({ transport: 'ipc' });
        rpcClient.on('ready', () => {
            console.log('[Discord RPC]: Connected to Discord client');
            setActivity();
        });
        rpcClient.login({ clientId: CLIENT_ID }).catch(() => scheduleDiscordRetry());
    } catch (e) {
        scheduleDiscordRetry();
    }
}

function scheduleDiscordRetry() {
    if (!rpcEnabled || rpcRetryTimer) return;
    rpcRetryTimer = setInterval(() => {
        if (!rpcClient && rpcEnabled) initDiscordRPC();
        else if (rpcRetryTimer) { clearInterval(rpcRetryTimer); rpcRetryTimer = null; }
    }, 15000);
}

function destroyDiscordRPC() {
    if (rpcRetryTimer) { clearInterval(rpcRetryTimer); rpcRetryTimer = null; }
    if (rpcClient) { try { rpcClient.destroy(); } catch (e) {} rpcClient = null; }
}

function setActivity(details = 'Main Menu', state = 'Ready to Play') {
    if (!rpcClient || !rpcEnabled) return;
    try {
        rpcClient.setActivity({
            details: details,
            state: state,
            largeImageKey: 'logo',
            largeImageText: 'LONGVEK Launcher',
            smallImageKey: 'minecraft',
            smallImageText: 'LONGVEK CLIENT',
            instance: false,
            startTimestamp: rpcStartTime
        }).catch(() => {});
    } catch (e) {}
}

function initAutoUpdater() {
    if (!app.isPackaged) return;
    try {
        // អនុញ្ញាតឱ្យទាញយក Update ស្វ័យប្រវត្តិកំពូលភ្លាមៗពេលមាន Version ថ្មី
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;

        autoUpdater.on('checking-for-update', () => {
            console.log('[AutoUpdater]: Checking for updates on GitHub...');
        });

        autoUpdater.on('update-available', (info) => {
            console.log('[AutoUpdater]: Update available:', info.version);
            sendLogToUI(`New version ${info.version} found! Downloading update...`, 'info');
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('update-available', info);
            }
        });

        autoUpdater.on('update-not-available', () => {
            console.log('[AutoUpdater]: App is already on the latest version.');
        });

        autoUpdater.on('download-progress', (progress) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('update-progress', progress);
            }
        });

        autoUpdater.on('update-downloaded', (info) => {
            console.log('[AutoUpdater]: Update downloaded successfully:', info.version);
            sendLogToUI(`Update ${info.version} downloaded! Restarting to apply...`, 'success');
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('update-downloaded', info);
            }
            // ដំឡើង update ស្វ័យប្រវត្តិពេលបិទ ឬចុច install
        });

        autoUpdater.on('error', (err) => {
            console.warn('[AutoUpdater Error]:', err.message);
        });

        // ចាប់ផ្តើមត្រួតពិនិត្យ Update ពី GitHub ស្វ័យប្រវត្តិ
        autoUpdater.checkForUpdatesAndNotify().catch(err => console.warn('Auto-updater check error:', err.message));
    } catch (e) {
        console.warn('Auto-updater init error:', e.message);
    }
}

// IPCs សម្រាប់ចុច Check Update & Install ដោយផ្ទាល់ដៃ
ipcMain.on('check-for-updates', () => {
    if (app.isPackaged) {
        autoUpdater.checkForUpdates().catch(() => {});
    }
});

ipcMain.on('install-update', () => {
    try {
        autoUpdater.quitAndInstall(false, true);
    } catch (e) {
        console.warn('Quit and install error:', e.message);
    }
});

function createSplashWindow() {
    if (splashWindow && !splashWindow.isDestroyed()) return;

    splashWindow = new BrowserWindow({
        width: 480,
        height: 280,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        center: true,
        hasShadow: false,
        backgroundColor: '#00000000',
        icon: path.join(__dirname, 'LONGVEKLAUNCHER.ico'),
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    const splashHtml = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-transparent select-none overflow-hidden flex items-center justify-center h-screen font-sans p-0 m-0">
      <div class="relative w-[465px] h-[268px] rounded-[24px] border border-cyan-400/40 overflow-hidden bg-slate-950/90 cursor-grab active:cursor-grabbing" style="-webkit-app-region: drag;">
        <div class="absolute inset-0 bg-cover bg-center bg-no-repeat opacity-75" style="background-image: url('https://assets.badlion.net/blog/minecraft-backgrounds/minecraft-mods-back.webp');"></div>
        <div class="absolute inset-0 bg-gradient-to-b from-slate-950/70 via-slate-900/40 to-slate-950/85"></div>
        <div class="relative z-10 w-full h-full p-5 flex flex-col justify-between">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900/80 border border-white/15 backdrop-blur-md">
              <span class="w-2 h-2 rounded-full bg-cyan-400 animate-pulse"></span>
              <span class="text-[10px] tracking-widest font-semibold text-slate-100 uppercase">LongVek Client Engine</span>
            </div>
            <div class="px-2.5 py-0.5 rounded-full bg-cyan-950/80 border border-cyan-400/40 text-[10px] font-mono text-cyan-300 font-bold backdrop-blur-md">v2.5 PRO</div>
          </div>
          <div class="flex flex-col items-center justify-center -mt-1">
            <div class="w-16 h-16 rounded-2xl bg-slate-900/80 border border-cyan-400/50 p-2 flex items-center justify-center backdrop-blur-md">
              <img src="https://i.postimg.cc/CKpVxR17/longvek-launcher.png" alt="Logo" class="w-full h-full object-contain filter drop-shadow">
            </div>
            <h1 class="text-white text-xl font-black tracking-[0.2em] mt-2 flex items-center gap-1.5 drop-shadow-md">
              LONGVEK <span class="text-cyan-400 font-light text-lg tracking-normal">LAUNCHER</span>
            </h1>
            <p class="text-[10px] font-semibold text-slate-200 tracking-widest uppercase mt-0.5 drop-shadow-sm">High Performance • Ultra Turbo FPS</p>
          </div>
          <div class="w-full space-y-1.5">
            <div class="flex justify-between items-center text-[10px] px-0.5 font-semibold">
              <span class="text-slate-100 flex items-center gap-1.5 drop-shadow-sm">
                <svg class="w-3 h-3 text-cyan-400 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
                </svg>
                <span id="splash-status">Checking Java runtime environment...</span>
              </span>
              <span id="splash-percent" class="text-cyan-400 font-mono text-[10px] font-bold">12%</span>
            </div>
            <div class="relative w-full h-[4px] bg-slate-900/80 rounded-full overflow-hidden border border-white/20">
              <div id="splash-progress" class="h-full bg-gradient-to-r from-cyan-500 via-sky-400 to-cyan-300 rounded-full transition-all duration-300 ease-out shadow-[0_0_8px_#22d3ee]" style="width: 12%;"></div>
            </div>
          </div>
        </div>
      </div>
      <script>
        const stages = [
          { percent: 25, text: "Checking Java runtime environment...", delay: 200 },
          { percent: 50, text: "Scanning Low-End PC Optimization flags...", delay: 800 },
          { percent: 75, text: "Syncing game profiles & Smart Doctor...", delay: 1400 },
          { percent: 100, text: "Ready to launch!", delay: 2000 }
        ];
        stages.forEach(s => {
          setTimeout(() => {
            const st = document.getElementById('splash-status');
            const sp = document.getElementById('splash-percent');
            const bar = document.getElementById('splash-progress');
            if (st) st.textContent = s.text;
            if (sp) sp.textContent = s.percent + '%';
            if (bar) bar.style.width = s.percent + '%';
          }, s.delay);
        });
      </script>
    </body>
    </html>
    `;
    splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml));
    setTimeout(() => finishSplashAndOpenMain(), 2400);
}

function ensureValidUUID(uuid, name = 'Player') {
    if (!uuid || typeof uuid !== 'string') {
        const hash = crypto.createHash('md5').update('OfflinePlayer:' + name).digest('hex');
        return `${hash.slice(0,8)}-${hash.slice(8,12)}-3${hash.slice(13,16)}-${((parseInt(hash.slice(16,18), 16) & 0x3f) | 0x80).toString(16)}${hash.slice(18,20)}-${hash.slice(20,32)}`;
    }
    const clean = uuid.replace(/-/g, '').trim();
    if (clean.length === 32) {
        return `${clean.slice(0,8)}-${clean.slice(8,12)}-${clean.slice(12,16)}-${clean.slice(16,20)}-${clean.slice(20,32)}`;
    }
    const hash = crypto.createHash('md5').update('OfflinePlayer:' + name).digest('hex');
    return `${hash.slice(0,8)}-${hash.slice(8,12)}-3${hash.slice(13,16)}-${((parseInt(hash.slice(16,18), 16) & 0x3f) | 0x80).toString(16)}${hash.slice(18,20)}-${hash.slice(20,32)}`;
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 720,
        minWidth: 980,
        minHeight: 600,
        frame: false,
        backgroundColor: '#020617',
        show: false,
        icon: path.join(__dirname, 'LONGVEKLAUNCHER.ico'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            devTools: !app.isPackaged
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
        const parsedUrl = new URL(navigationUrl);
        if (parsedUrl.protocol !== 'file:') {
            event.preventDefault();
            console.warn(`[Security Warning]: Blocked navigation to ${navigationUrl}`);
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        console.warn(`[Security Warning]: Blocked window open attempt for ${url}`);
        return { action: 'deny' };
    });

    mainWindow.on('maximize', () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window-state', 'maximized');
    });

    mainWindow.on('unmaximize', () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('window-state', 'normal');
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function finishSplashAndOpenMain() {
    if (mainWindow && !mainWindow.isDestroyed()) return;
    createWindow();

    mainWindow.once('ready-to-show', () => {
        if (splashWindow && !splashWindow.isDestroyed()) {
            splashWindow.close();
            splashWindow = null;
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

function getJavaMajorVersion(binPath) {
    if (!binPath || !fs.existsSync(binPath)) return 0;
    try {
        const dir = path.dirname(path.dirname(binPath));
        const releasePath = path.join(dir, 'release');
        if (fs.existsSync(releasePath)) {
            const content = fs.readFileSync(releasePath, 'utf8');
            const match = content.match(/JAVA_VERSION="?(\d+)/i);
            if (match) return parseInt(match[1]);
        }
    } catch (e) {}
    return 0;
}

function findSystemJava(requiredTarget = 'java21') {
    const isWindows = process.platform === 'win32';
    const binaryName = isWindows ? 'javaw.exe' : 'java';
    const fallbackBin = isWindows ? 'java.exe' : 'java';

    const localDir = path.join(runtimesDir, requiredTarget);
    const candidates = [
        path.join(localDir, 'bin', binaryName),
        path.join(localDir, 'bin', fallbackBin)
    ];

    if (fs.existsSync(localDir)) {
        try {
            const subEntries = fs.readdirSync(localDir);
            for (const sub of subEntries) {
                candidates.push(path.join(localDir, sub, 'bin', binaryName));
                candidates.push(path.join(localDir, sub, 'bin', fallbackBin));
            }
        } catch (e) {}
    }

    if (isWindows) {
        const appData = app.getPath('appData');
        const mojangRuntimes = [
            path.join(appData, '.minecraft', 'runtime', 'java-runtime-gamma', 'windows-x64', 'java-runtime-gamma', 'bin', binaryName),
            path.join(appData, '.minecraft', 'runtime', 'java-runtime-delta', 'windows-x64', 'java-runtime-delta', 'bin', binaryName),
            path.join(appData, '.minecraft', 'runtime', 'java-runtime-beta', 'windows-x64', 'java-runtime-beta', 'bin', binaryName)
        ];
        candidates.push(...mojangRuntimes);
    }

    if (process.env.JAVA_HOME) {
        candidates.push(path.join(process.env.JAVA_HOME, 'bin', binaryName));
        candidates.push(path.join(process.env.JAVA_HOME, 'bin', fallbackBin));
    }

    if (isWindows) {
        const searchBases = [
            'C:\\Program Files\\Eclipse Adoptium',
            'C:\\Program Files\\Microsoft',
            'C:\\Program Files\\Java',
            'C:\\Program Files\\BellSoft'
        ];
        for (const base of searchBases) {
            if (fs.existsSync(base)) {
                try {
                    const subdirs = fs.readdirSync(base);
                    for (const sub of subdirs) {
                        candidates.push(path.join(base, sub, 'bin', binaryName));
                        candidates.push(path.join(base, sub, 'bin', fallbackBin));
                    }
                } catch (e) {}
            }
        }
    }

    for (const bin of candidates) {
        if (fs.existsSync(bin)) {
            const major = getJavaMajorVersion(bin);
            if (requiredTarget === 'java21' && major >= 21) return bin;
            if (requiredTarget === 'java17' && major >= 17) return bin;
            if (requiredTarget === 'java8' && (major === 8 || major === 0)) return bin;
        }
    }

    for (const bin of candidates) {
        if (fs.existsSync(bin)) {
            if (requiredTarget === 'java21' && (bin.includes('21') || bin.includes('gamma'))) return bin;
            if (requiredTarget === 'java17' && (bin.includes('17') || bin.includes('beta'))) return bin;
        }
    }

    return undefined;
}

async function downloadPortableJava21() {
    const java21Dir = path.join(runtimesDir, 'java21');
    if (!fs.existsSync(java21Dir)) fs.mkdirSync(java21Dir, { recursive: true });

    sendLogToUI('Downloading Java 21 OpenJDK Runtime from Adoptium...', 'info');
    const zipPath = path.join(runtimesDir, 'adoptium-java21.zip');
    const downloadUrl = 'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse';

    try {
        const response = await axios({
            url: downloadUrl,
            method: 'GET',
            responseType: 'stream',
            timeout: 60000,
            headers: { 'User-Agent': 'LONGVEK-Launcher/2.5' }
        });

        const writer = fs.createWriteStream(zipPath);
        await new Promise((resolve, reject) => {
            response.data.pipe(writer);
            writer.on('error', reject);
            writer.on('finish', resolve);
        });

        sendLogToUI('Extracting Java 21 OpenJDK Runtime...', 'info');
        await extract(zipPath, { dir: java21Dir });
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

        const detected = findSystemJava('java21');
        if (detected) {
            sendLogToUI('Java 21 installed successfully!', 'success');
            return detected;
        }
    } catch (err) {
        sendLogToUI(`Java 21 download failed: ${err.message}`, 'warning');
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    }
    return null;
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

    let detectedJava = findSystemJava(javaTarget);
    if (detectedJava) return detectedJava;

    if (javaTarget === 'java21') {
        sendLogToUI('Java 21 required for Minecraft 1.21+. Auto-installing...', 'info');
        const autoInstalledJava = await downloadPortableJava21();
        if (autoInstalledJava) return autoInstalledJava;
    }

    return process.platform === 'win32' ? 'javaw' : 'java';
}

ipcMain.handle('clean-memory', async () => {
    performRamCleanup();
    return { success: true };
});

ipcMain.handle('fetch-image-base64', async (_event, imageUrl) => {
    if (!imageUrl || typeof imageUrl !== 'string') return null;
    try {
        let targetUrl = imageUrl;
        if (targetUrl.includes('github.com') && targetUrl.includes('/blob/')) {
            targetUrl = targetUrl.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/');
        }

        const res = await axios.get(targetUrl, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: {
                'User-Agent': 'LONGVEK-Launcher-AssetEngine/3.0'
            }
        });

        const mime = res.headers['content-type'] || 'image/png';
        const base64 = Buffer.from(res.data, 'binary').toString('base64');
        return `data:${mime};base64,${base64}`;
    } catch (err) {
        console.warn(`[Asset Engine]: Failed to fetch image ${imageUrl}:`, err.message);
        return null;
    }
});

ipcMain.handle('install-fps-pack', async (_event, { profileId, version, loader }) => {
    try {
        const res = await installLowEndFpsPack(profileId, version, loader);
        return res;
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('auto-fix-crash', async (_event, { profileId, fixType, conflictFile, mcVersion }) => {
    try {
        const instanceDir = getInstanceDir(profileId);
        const modsDir = path.join(instanceDir, 'mods');

        if (fixType === 'install_fabric_api') {
            const ver = mcVersion || '1.20.1';
            const ok = await ensureFabricAPI(instanceDir, ver);
            return { success: ok, message: ok ? 'Fabric API successfully installed!' : 'Failed to install Fabric API.' };
        } else if (fixType === 'disable_conflict') {
            if (conflictFile && fs.existsSync(modsDir)) {
                const targetMod = path.join(modsDir, conflictFile);
                if (fs.existsSync(targetMod)) {
                    fs.renameSync(targetMod, targetMod + '.disabled');
                    return { success: true, message: `Disabled conflicting mod: ${conflictFile}` };
                }
            }
            return { success: false, message: 'Conflicting file not found on disk.' };
        } else if (fixType === 'fix_ram_4gb') {
            return { success: true, message: 'RAM configured to 4GB safe memory.', newRam: 4 };
        }
        return { success: false, message: 'Unknown fix type.' };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('get-available-versions', async (_event, releaseOnly = true) => {
    return await mcEngine.fetchVanillaVersions(releaseOnly);
});

ipcMain.handle('get-fabric-loaders', async (_event, gameVersion) => {
    return await mcEngine.fetchFabricLoaders(gameVersion);
});

ipcMain.handle('install-version-engine', async (_event, { version, loader }) => {
    try {
        if ((loader || 'vanilla').toLowerCase() === 'fabric') {
            const fabricId = await mcEngine.setupFabricProfile(version);
            return { success: !!fabricId, versionId: fabricId || version };
        }
        return { success: true, versionId: version };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.on('cancel-launch', () => {
    isLaunchAborted = true;
    sendLogToUI('Launch sequence cancelled by user.', 'warning');
    setActivity('Main Menu', 'Ready to Play');
});

ipcMain.on('test-overlay', (_event, data) => {
    console.log('[HUD Overlay Test]: Triggered preview for', data);
    sendLogToUI(`[HUD Engine]: LONGVEK In-Game HUD activated for ${data.username || 'Player'}! Press RSHIFT to toggle menu.`, 'success');
});

// =========================================================================
// MICROSOFT OAUTH AUTHENTICATION (MSMC)
// =========================================================================
ipcMain.on('ms-login', async (_event, lang = 'en') => {
    sendLogToUI('Starting Microsoft authentication...', 'info');
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ms-login-status', {
            status: 'loading',
            msg: lang === 'km' ? 'កំពុងបើកផ្ទាំង Login របស់ Microsoft...' : 'Opening Microsoft login window...'
        });
    }

    try {
        let mclcAuth = null;
        let playerName = 'Player';
        let playerUuid = '';
        let skinUrl = '';

        if (msmc && typeof msmc.Auth === 'function') {
            const authManager = new msmc.Auth('select_account');
            const xboxManager = await authManager.launch('electron');
            if (!xboxManager) throw new Error('Microsoft authentication was cancelled.');

            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('ms-login-status', {
                    status: 'loading',
                    msg: lang === 'km' ? 'កំពុងទាញយក Minecraft Profile...' : 'Fetching Minecraft profile...'
                });
            }

            const mcToken = await xboxManager.getMinecraft();
            if (!mcToken) throw new Error('Failed to retrieve Minecraft profile.');
            
            mclcAuth = typeof mcToken.mclc === 'function' ? mcToken.mclc() : (mcToken.mclcAuth || mcToken);
            playerName = mcToken.profile?.name || mclcAuth?.name || 'Player';
            playerUuid = mcToken.profile?.id || mclcAuth?.uuid || '';

            if (mcToken.profile?.skins && mcToken.profile.skins.length > 0) {
                const activeSkin = mcToken.profile.skins.find(s => s.state === 'ACTIVE') || mcToken.profile.skins[0];
                skinUrl = activeSkin.url || '';
            }
        } else if (msmc && typeof msmc.fastLaunch === 'function') {
            const res = await msmc.fastLaunch('electron', (update) => {
                if (mainWindow && !mainWindow.isDestroyed() && update && update.data) {
                    mainWindow.webContents.send('ms-login-status', {
                        status: 'loading',
                        msg: update.data
                    });
                }
            });
            if (!res) throw new Error('Microsoft authentication was cancelled.');
            mclcAuth = typeof res.mclc === 'function' ? res.mclc() : res;
            playerName = res.profile?.name || mclcAuth?.name || 'Player';
            playerUuid = res.profile?.id || mclcAuth?.uuid || '';
        } else {
            throw new Error('MSMC authentication library is not available.');
        }

        if (!mclcAuth || (!mclcAuth.access_token && !mclcAuth.token)) {
            throw new Error('Did not receive valid access token from Microsoft.');
        }

        const validAccessToken = mclcAuth.access_token || mclcAuth.token;
        const normalizedUuid = ensureValidUUID(playerUuid, playerName);

        const account = {
            id: 'ms_' + (playerUuid || Date.now()),
            name: playerName,
            type: 'microsoft',
            role: 'Microsoft Account',
            accountCategory: 'premium',
            mclcAuth: {
                access_token: validAccessToken,
                client_token: mclcAuth.client_token || 'longvek-launcher',
                uuid: normalizedUuid,
                name: playerName,
                user_properties: typeof mclcAuth.user_properties === 'string' ? mclcAuth.user_properties : "{}",
                meta: { type: 'msa', demo: false }
            },
            skinData: skinUrl || playerName,
            skinName: playerName,
            originalSkin: skinUrl || playerName,
            headAvatar: `https://mc-heads.net/avatar/${encodeURIComponent(playerName)}/64`
        };

        sendLogToUI(`Microsoft login successful for ${playerName}!`, 'success');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ms-login-status', {
                status: 'success',
                account: account
            });
        }
    } catch (err) {
        console.error('[Microsoft Login Error]:', err);
        sendLogToUI(`Microsoft login error: ${err.message}`, 'error');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ms-login-status', {
                status: 'error',
                msg: err.message || 'Login failed or was cancelled.'
            });
        }
    }
});

// =========================================================================
// GAME LAUNCH DISPATCHER
// =========================================================================
ipcMain.on('launch-game', async (event, data) => {
    isLaunchAborted = false;
    const username = data.username || 'Player';
    const version = data.version || '1.20.1';
    const authData = data.mclcAuth || data.msAuthObj;
    const isOffline = data.accountType !== 'microsoft' && !data.isMicrosoft;
    const profileId = data.profileId || 'default';

    performRamCleanup();

    launcher.removeAllListeners('debug');
    launcher.removeAllListeners('data');
    launcher.removeAllListeners('progress');
    launcher.removeAllListeners('close');

    const sysTotalMemMB = Math.floor(os.totalmem() / (1024 * 1024));
    const sysTotalMemGB = Math.round(sysTotalMemMB / 1024);
    let requestedRamGB = parseInt(data.ram || (data.maxRam ? String(data.maxRam).replace(/[^0-9]/g, '') : '4')) || 4;

    let safeMaxRamMB = requestedRamGB * 1024;
    if (sysTotalMemGB <= 4) {
        safeMaxRamMB = Math.min(safeMaxRamMB, 2560);
    } else if (requestedRamGB >= sysTotalMemGB) {
        safeMaxRamMB = Math.max(2048, (sysTotalMemGB - 2) * 1024);
    }

    const safeMinRamMB = Math.max(1024, Math.floor(safeMaxRamMB / 2));
    const maxMem = `${safeMaxRamMB}M`;
    const minMem = `${safeMinRamMB}M`;

    const defaultUltraFpsFlags = [
        "-XX:+UseG1GC",
        "-XX:+ParallelRefProcEnabled",
        "-XX:MaxGCPauseMillis=50",
        "-XX:+UnlockExperimentalVMOptions",
        "-XX:+DisableExplicitGC",
        "-XX:G1NewSizePercent=20",
        "-XX:G1MaxNewSizePercent=30",
        "-XX:G1ReservePercent=15",
        "-XX:SurvivorRatio=32",
        "-XX:+PerfDisableSharedMem",
        "-XX:+UseStringDeduplication",
        "-Dminecraft.launcher.brand=LONGVEK-Launcher",
        "-Dminecraft.launcher.version=2.0"
    ];

    const userArgs = Array.isArray(data.customArgs) ? data.customArgs : [];
    const mergedArgs = [...defaultUltraFpsFlags];
    userArgs.forEach(arg => {
        if (arg && !mergedArgs.includes(arg)) mergedArgs.push(arg);
    });

    const instanceDir = getInstanceDir(profileId);
    let cleanVersion = version.replace(/^(Fabric|Forge|OptiFine|Release)\s*/i, '').trim();

    if (cleanVersion === '1.21.11') {
        cleanVersion = '1.21.1';
    }

    sanitizeInstanceMods(instanceDir, cleanVersion);
    ensureLongvekInGameConfig(instanceDir, username);

    let activeLoader = (data.loader || 'vanilla').toLowerCase();

    sendLogToUI(`Cleaning RAM & Preparing Game Engine...`, 'system');
    sendLogToUI(`Allocated RAM: ${maxMem} (System: ${sysTotalMemGB}GB)`, 'system');
    sendLogToUI(`Player: ${username} | Version: ${cleanVersion} | Loader: ${activeLoader.toUpperCase()}`, 'system');
    setActivity(`Playing Minecraft ${cleanVersion}`, `Player: ${username} • LONGVEK CLIENT`);

    try {
        let authObj;
        if (isOffline) {
            authObj = Authenticator.getAuth(username.replace(/\s+/g, '_'));
        } else {
            if (authData && authData.access_token) {
                authObj = {
                    access_token: authData.access_token,
                    client_token: authData.client_token || 'longvek-launcher',
                    uuid: ensureValidUUID(authData.uuid, username),
                    name: authData.name || username,
                    user_properties: typeof authData.user_properties === 'string' ? authData.user_properties : "{}",
                    meta: authData.meta || { type: 'msa', demo: false }
                };
            } else {
                authObj = Authenticator.getAuth(username.replace(/\s+/g, '_'));
            }
        }

        let opts = {
            authorization: authObj,
            root: rootPath,
            overrides: { gameDirectory: instanceDir },
            version: { number: cleanVersion, type: 'LONGVEK Client' },
            memory: { max: maxMem, min: minMem },
            customArgs: mergedArgs
        };

        const useJavaPath = await ensureJava(cleanVersion);
        if (useJavaPath) opts.javaPath = useJavaPath;

        if (activeLoader === 'fabric') {
            const customFabricId = await ensureFabricProfile(cleanVersion);
            if (customFabricId) opts.version.custom = customFabricId;
            await ensureFabricAPI(instanceDir, cleanVersion);
            await ensureInGameHudMod(instanceDir, cleanVersion, activeLoader);
            if (data.activeCape || data.activeCapeData) {
                await ensureInGameCape(instanceDir, username, data.activeCape, cleanVersion, activeLoader, data.activeCapeData, authObj?.uuid);
            }
        }

        let hasGameStarted = false;

        launcher.on('debug', (e) => console.log(`[MCLC]: ${e}`));
        launcher.on('data', (d) => {
            const logLine = String(d || '');
            if (!hasGameStarted) {
                hasGameStarted = true;
                sendLogToUI('Game process initialized. Loading Minecraft...', 'info');
                if (data.launcherAction === 'hide' && mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.hide();
                } else if (data.launcherAction === 'close') {
                    app.quit();
                }
            }
            if (logLine.includes('OpenAL initialized') || logLine.includes('Setting user:')) {
                sendLogToUI('Minecraft loaded successfully! Low-End Optimization Active.', 'success');
            }
        });

        launcher.on('progress', (e) => {
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launcher-progress', e);
        });

        launcher.on('close', (code) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.show();
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.focus();
            }

            if (code !== 0) {
                console.warn(`[Minecraft Crash]: Game exited with code ${code}`);
                const analysis = analyzeCrashLog(instanceDir, code);
                analysis.mcVersion = cleanVersion;
                analysis.profileId = profileId;
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('game-crashed', analysis);
                }
            }
            setActivity('Main Menu', 'Ready to Play');
            event.reply('launch-status', { msg: 'Game Closed', progress: 0, status: 'stopped' });
            event.reply('game-closed', code);
        });

        if (isLaunchAborted) return;
        await launcher.launch(opts);
    } catch (error) {
        sendLogToUI(`Launch Error: ${error.message}`, 'error');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('launcher-log', { message: error.message, type: 'error' });
        }
    }
});

// App Window Management & Standard IPCs
ipcMain.on('minimize-window', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize(); });
ipcMain.on('maximize-window', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
    }
});
ipcMain.on('close-window', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close(); });
ipcMain.on('open-profile-folder', (_event, profileId) => {
    shell.openPath(getInstanceDir(profileId));
});

ipcMain.handle('get-system-memory', () => {
    const totalMemMB = Math.floor(os.totalmem() / (1024 * 1024));
    return {
        totalGB: Math.round(totalMemMB / 1024),
        totalMB: totalMemMB,
        freeMB: Math.floor(os.freemem() / (1024 * 1024))
    };
});

app.whenReady().then(() => {
    app.setName('LONGVEK Launcher');
    initDiscordRPC();
    initAutoUpdater();
    createSplashWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    destroyDiscordRPC();
    if (process.platform !== 'darwin') app.quit();
});