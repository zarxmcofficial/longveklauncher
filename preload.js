const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    // --- Window Controls ---
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    maximizeWindow: () => ipcRenderer.send('maximize-window'),
    closeWindow: () => ipcRenderer.send('close-window'),

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
    updateDiscordRPC: (state, details) => ipcRenderer.send('update-discord-rpc', { state, details }),

    // --- Content Manager (Mods, Resource Packs, Shaders) ---
    getInstalledContent: () => ipcRenderer.invoke('get-installed-content'),
    installMod: (data) => ipcRenderer.send('install-mod', data),
    onModInstalled: (callback) => {
        ipcRenderer.removeAllListeners('mod-installed');
        ipcRenderer.on('mod-installed', (_event, modName) => callback(modName));
    },
    deleteContentFile: (category, fileName) => ipcRenderer.invoke('delete-content-file', { category, fileName }),
    deleteMod: (modData) => ipcRenderer.send('delete-mod', modData),
    toggleContentFile: (category, fileName, enable) => ipcRenderer.invoke('toggle-content-file', { category, fileName, enable }),
    toggleMod: (data) => ipcRenderer.send('toggle-mod', data),
    addCustomContentFiles: (category) => ipcRenderer.invoke('add-custom-content-files', category),

    // --- Folder Navigation & Optimization ---
    openGameFolder: (subFolder) => ipcRenderer.send('open-game-folder', subFolder),
    openProfileFolder: (profileId) => ipcRenderer.send('open-profile-folder', profileId),
    applyFpsBoost: (profileId) => ipcRenderer.send('apply-fps-boost', profileId),

    // --- Bug Report & Feedback Submission ---
    submitBugReport: (reportData) => ipcRenderer.invoke('submit-bug-report', reportData)
});