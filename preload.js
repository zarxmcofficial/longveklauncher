const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // --- Window Controls ---
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    maximizeWindow: () => ipcRenderer.send('maximize-window'),
    closeWindow: () => ipcRenderer.send('close-window'),
    onWindowState: (callback) => {
        ipcRenderer.removeAllListeners('window-state');
        ipcRenderer.on('window-state', (_event, state) => callback(state));
    },

    // --- Splash Screen & Startup Listener ---
    onSplashUpdateStatus: (callback) => {
        ipcRenderer.removeAllListeners('splash-update-status');
        ipcRenderer.on('splash-update-status', (_event, data) => callback(data));
    },

    // --- Authentication (Microsoft & Offline) ---
    msLogin: (lang = 'en') => ipcRenderer.send('ms-login', lang),
    loginMicrosoft: () => ipcRenderer.invoke('login-microsoft'),
    onMsLoginStatus: (callback) => {
        ipcRenderer.removeAllListeners('ms-login-status');
        ipcRenderer.on('ms-login-status', (_event, data) => callback(data));
    },

    // --- Version Management ---
    getLocalVersions: () => ipcRenderer.invoke('get-local-versions'),
    getAvailableVersions: (releaseOnly) => ipcRenderer.invoke('get-available-versions', releaseOnly),
    getFabricLoaders: (gameVersion) => ipcRenderer.invoke('get-fabric-loaders', gameVersion),
    installVersionEngine: (options) => ipcRenderer.invoke('install-version-engine', options),

    // --- Game Launching & Controls ---
    launchGame: (options) => ipcRenderer.send('launch-game', options),
    cancelLaunch: () => ipcRenderer.send('cancel-launch'),

    // --- Launch Status & Log Listeners ---
    onLaunchStatus: (callback) => {
        ipcRenderer.removeAllListeners('launch-status');
        ipcRenderer.on('launch-status', (_event, data) => callback(data));
    },
    onLauncherLog: (callback) => {
        ipcRenderer.removeAllListeners('launcher-log');
        ipcRenderer.on('launcher-log', (_event, data) => callback(data));
    },
    onLauncherProgress: (callback) => {
        ipcRenderer.removeAllListeners('launcher-progress');
        ipcRenderer.on('launcher-progress', (_event, data) => callback(data));
    },
    onSessionExpiredNotice: (callback) => {
        ipcRenderer.removeAllListeners('session-expired-notice');
        ipcRenderer.on('session-expired-notice', (_event, data) => callback(data));
    },
    onSessionExpiredRelogin: (callback) => {
        ipcRenderer.removeAllListeners('session-expired-relogin');
        ipcRenderer.on('session-expired-relogin', (_event, data) => callback(data));
    },
    onAccountTokenRefreshed: (callback) => {
        ipcRenderer.removeAllListeners('account-token-refreshed');
        ipcRenderer.on('account-token-refreshed', (_event, data) => callback(data));
    },
    onGameCrashed: (callback) => {
        ipcRenderer.removeAllListeners('game-crashed');
        ipcRenderer.on('game-crashed', (_event, analysis) => callback(analysis));
    },
    onGameClosed: (callback) => {
        ipcRenderer.removeAllListeners('game-closed');
        ipcRenderer.on('game-closed', (_event, data) => callback(data));
    },

    // --- Auto-Update System ---
    checkForUpdates: () => ipcRenderer.send('check-for-updates'),
    installUpdate: () => ipcRenderer.send('install-update'),
    onUpdateAvailable: (callback) => {
        ipcRenderer.removeAllListeners('update-available');
        ipcRenderer.on('update-available', (_event, info) => callback(info));
    },
    onUpdateProgress: (callback) => {
        ipcRenderer.removeAllListeners('update-progress');
        ipcRenderer.on('update-progress', (_event, progress) => callback(progress));
    },
    onUpdateDownloaded: (callback) => {
        ipcRenderer.removeAllListeners('update-downloaded');
        ipcRenderer.on('update-downloaded', (_event, info) => callback(info));
    },

    // --- System & Hardware Specs (RAM Calculator) ---
    getSystemMemory: () => ipcRenderer.invoke('get-system-memory'),
    requestSystemInfo: () => ipcRenderer.send('request-system-info'),
    onSystemInfo: (callback) => {
        ipcRenderer.removeAllListeners('system-info');
        ipcRenderer.on('system-info', (_event, data) => callback(data));
    },
    openExternalLink: (url) => ipcRenderer.send('open-external-link', url),

    // --- Discord Rich Presence (RPC) ---
    toggleDiscordRPC: (enable) => ipcRenderer.send('toggle-discord-rpc', enable),
    updateDiscordRPC: (details, state) => ipcRenderer.send('update-discord-rpc', { details, state }),

    // --- Content Manager (Mods, Resource Packs, Shaders) ---
    getInstalledContent: (profileId) => ipcRenderer.invoke('get-installed-content', profileId),
    installMod: (data) => ipcRenderer.send('install-mod', data),
    onModDownloadProgress: (callback) => {
        ipcRenderer.removeAllListeners('mod-download-progress');
        ipcRenderer.on('mod-download-progress', (_event, data) => callback(data));
    },
    onModInstalled: (callback) => {
        ipcRenderer.removeAllListeners('mod-installed');
        ipcRenderer.on('mod-installed', (_event, modName) => callback(modName));
    },
    onModInstallError: (callback) => {
        ipcRenderer.removeAllListeners('mod-install-error');
        ipcRenderer.on('mod-install-error', (_event, data) => callback(data));
    },
    deleteContentFile: (category, fileName, profileId) => ipcRenderer.invoke('delete-content-file', { category, fileName, profileId }),
    deleteMod: (modData) => ipcRenderer.send('delete-mod', modData),
    toggleContentFile: (category, fileName, enable, profileId) => ipcRenderer.invoke('toggle-content-file', { category, fileName, enable, profileId }),
    toggleMod: (data) => ipcRenderer.send('toggle-mod', data),
    addCustomContentFiles: (category, profileId) => ipcRenderer.invoke('add-custom-content-files', { category, profileId }),

    // --- Folder Navigation & Optimization ---
    openGameFolder: (subFolder, profileId) => ipcRenderer.send('open-game-folder', subFolder, profileId),
    openProfileFolder: (profileId) => ipcRenderer.send('open-profile-folder', profileId),
    applyFpsBoost: (profileId) => ipcRenderer.send('apply-fps-boost', profileId),

    // --- LOW-END PC BOOST PACK & AUTO-DOCTOR APIS ---
    installFpsPack: (data) => ipcRenderer.invoke('install-fps-pack', data),
    autoFixCrash: (data) => ipcRenderer.invoke('auto-fix-crash', data),
    cleanMemory: () => ipcRenderer.invoke('clean-memory'),

    // --- Modpack Import & Mod Counter APIs ---
    getProfileModCount: (profileId) => ipcRenderer.invoke('get-profile-mod-count', profileId),
    importModpackFile: (filePath) => ipcRenderer.invoke('import-modpack-file', filePath),
    onModpackImportProgress: (callback) => {
        ipcRenderer.removeAllListeners('modpack-import-progress');
        ipcRenderer.on('modpack-import-progress', (_event, data) => callback(data));
    },

    // --- Screenshots Gallery Manager APIs ---
    getScreenshots: (profileId) => ipcRenderer.invoke('get-screenshots', profileId),
    deleteScreenshot: (filePath) => ipcRenderer.invoke('delete-screenshot', filePath),
    copyScreenshotImage: (filePath) => ipcRenderer.invoke('copy-screenshot-image', filePath),
    openScreenshotFolder: (profileId) => ipcRenderer.send('open-screenshot-folder', profileId),

    // --- In-Game Cyber HUD Test Action ---
    testOverlay: (data) => ipcRenderer.send('test-overlay', data),

    // --- High-Performance Texture & Image Base64 Fetcher ---
    fetchImageBase64: (url) => ipcRenderer.invoke('fetch-image-base64', url),

    // --- P2P Friend Worlds (e4mc / Essential Integration) ---
    checkP2PDomain: (domain) => ipcRenderer.invoke('check-p2p-domain', domain),
    installE4mcMod: (profileId, version, loader) => ipcRenderer.invoke('install-e4mc-mod', { profileId, version, loader }),
    copyToClipboard: (text) => ipcRenderer.send('copy-to-clipboard', text),

    // --- Bug Report & Feedback Submission ---
    submitBugReport: (reportData) => ipcRenderer.invoke('submit-bug-report', reportData)
});