const axios = require('axios');
const {
    app,
    BrowserWindow,
    ipcMain,
    session,
    safeStorage
} = require('electron');
app.commandLine.appendSwitch('lang', 'en-GB');
const pendingWLDecisions = new Map();

const {
    verifyLicense
} = require('./licenseManager');

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Boss ka Electron data folder fixed rakhein, taaki uninstall script exact folder clean kar sake.
const BOSS_USER_DATA_PATH = path.join(app.getPath('appData'), 'Boss');
app.setPath('userData', BOSS_USER_DATA_PATH);
const { exec, spawn } = require('child_process');
const puppeteer = require('puppeteer');

const APIEngine = require('./apiengine');
const apiKeyStore = require('./api-key-store');
const { startManualLogin } = require('./loginManager');

let win = null;
let licenseWindow = null;
const qrPaymentWindows = new Map();
let miniAutomationWindows = new Map();
let miniAutomationWindowsByBrowser = new Map();
const managedBrowserInstances = new Map();
const managedBrowserProcesses = new Map();
const profileResetInProgress = new Set();

async function cleanupBossProfileAfterClose(config) {

    if (
        !config?.userDataDir ||
        profileResetInProgress.has(config.type)
    ) {
        return;
    }

    profileResetInProgress.add(config.type);

    try {

        await fs.promises.rm(config.userDataDir, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 1000
        });

        console.log(
            `[PROFILE CLEANUP ${config.type}] Closed browser profile removed: ${config.userDataDir}`
        );

    } catch (error) {

        console.error(
            `[PROFILE CLEANUP ${config.type}] Could not remove profile:`,
            error.message
        );

    } finally {

        profileResetInProgress.delete(config.type);

    }
}

let licenseVerified = false;
let activeLicenseScope = null;

function createLicenseScope(licenseKey) {
    return crypto.createHash('sha256')
        .update(String(licenseKey).trim(), 'utf8')
        .digest('hex');
}

function applyLicenseBrowserRoot(scope) {
    const root = path.join(
        process.env.LOCALAPPDATA || os.homedir(),
        'Boss',
        'BrowserProfiles',
        scope
    );

    for (const [type, folder] of Object.entries({
        WEB: 'Chrome',
        WEB2: 'Edge',
        WEB3: 'Brave',
        WEB4: 'Firefox'
    })) {
        if (BROWSER_CONFIG[type]) {
            BROWSER_CONFIG[type].userDataDir = path.join(root, folder);
        }
    }
}

// ==========================================
// SECURE API KEY MANAGEMENT
// ==========================================

function validateApiKeySender(event) {
    if (
        !win ||
        win.isDestroyed() ||
        event.sender !== win.webContents
    ) {
        throw new Error('Unauthorized API key request.');
    }
}

ipcMain.handle(
    'api-keys:get-status',
    (event) => {
        validateApiKeySender(event);
        return apiKeyStore.getApiKeyStatus();
    }
);

ipcMain.handle(
    'api-keys:save',
    (event, values = {}) => {
        validateApiKeySender(event);
        return apiKeyStore.saveApiKeys(values);
    }
);

function createQRPaymentWindow(browserType = 'WEB', targetMiniWin = null) {

    const type =
        String(browserType || 'WEB')
            .trim()
            .toUpperCase();

            console.log(
    '[QR WINDOW DEBUG] browserType:',
    browserType,
    '| normalized type:',
    type
);

    const existingWindow =
        qrPaymentWindows.get(type);

    if (
    existingWindow &&
    !existingWindow.isDestroyed()
) {

    if (
        typeof miniAutomationWindows !== 'undefined'
    ) {
    const miniWin =
    targetMiniWin && !targetMiniWin.isDestroyed()
        ? targetMiniWin
        : miniAutomationWindowsByBrowser.get(type);

        if (
            miniWin &&
            !miniWin.isDestroyed()
        ) {
            const [miniX, miniY] =
                miniWin.getPosition();

            existingWindow.setPosition(
                miniX,
                miniY
            );
        }
    }

    existingWindow.show();
    existingWindow.focus();

    return existingWindow;
}

   const qrWindow =
    new BrowserWindow({
        width: 300,
        height: 360,
        minWidth: 300,
        minHeight: 360,

        movable: true,
        alwaysOnTop: true,
        autoHideMenuBar: true,

        // VPS compatibility: transparent window disabled
        backgroundColor: '#FFFFFF',
        transparent: false,

        webPreferences: {
            preload: path.join(
                __dirname,
                'preload.js'
            ),
            contextIsolation: true,
            nodeIntegration: false,
            backgroundThrottling: false
        }
    });

    qrPaymentWindows.set(
        type,
        qrWindow
    );

    qrWindow.loadFile(
        path.join(
            __dirname,
            'qr-payment.html'
        )
    );

    qrWindow.webContents.once(
        'did-finish-load',
        () => {
            console.log(
                `[QR WINDOW ${type}] qr-payment.html loaded.`
            );
        }
    );

    qrWindow.on(
        'closed',
        () => {

            if (
                qrPaymentWindows.get(type) ===
                qrWindow
            ) {
                qrPaymentWindows.delete(type);
            }
        }
    );

const miniWin =
    targetMiniWin && !targetMiniWin.isDestroyed()
        ? targetMiniWin
        : miniAutomationWindowsByBrowser.get(type);

if (
    miniWin &&
    !miniWin.isDestroyed()
) {
    const [miniX, miniY] =
        miniWin.getPosition();

    qrWindow.setPosition(
        miniX,
        miniY
    );

    console.log(
        `[QR WINDOW ${type}] Positioned beside target mini window`,
        miniWin.id
    );
} else {
    console.warn(
        `[QR WINDOW ${type}] Target mini window not available`
    );
}

qrWindow.show();
qrWindow.focus();

return qrWindow;
}


ipcMain.handle('search-route-trains', async (event, data) => {
    try {
        const { fromStation, toStation, journeyDate } = data || {};

        const savedKeys = apiKeyStore.getApiKeys();
const apiKey = savedKeys.directApiSh;

        if (!apiKey) {
    return {
        success: false,
        error: 'API.SH key nahi mili. Tokens tab mein apni API key save karein.'
    };
}

        if (!fromStation || !toStation || !journeyDate) {
            return {
                success: false,
                error: 'From, To aur Journey Date zaroori hain.'
            };
        }

        // YYYYMMDD ko YYYY-MM-DD mein convert karein
        const dateText = String(journeyDate).replace(/-/g, '');

        if (!/^\d{8}$/.test(dateText)) {
            return {
                success: false,
                error: 'Journey date format galat hai.'
            };
        }

        const date =
            dateText.substring(0, 4) + '-' +
            dateText.substring(4, 6) + '-' +
            dateText.substring(6, 8);

        const response = await axios.get(
            'https://api.api.sh/indian-rail/v1/trains',
            {
                params: {
                    from: fromStation.trim().toUpperCase(),
                    to: toStation.trim().toUpperCase(),
                    date: date
                },
                headers: {
                    'x-api-key': apiKey
                },
                timeout: 30000
            }
        );

        const raw = response.data;
        const trainList = Array.isArray(raw.trains)
            ? raw.trains
            : [];

        const trains = trainList.map(t => ({
            trainNumber: t.number || '',
            trainName: t.name || t.full_name || '',
            departureTime: t.departure || '--',
            arrivalTime: t.arrival || '--',
            duration: t.duration || '--',
            runningDays: t.run_days || [],
            avlClasses: t.classes || [],
            fares: t.fares || {},
            availability: 'Live seat availability not provided by API.SH'
        }));

        return {
            success: true,
            total: trains.length,
            trains,
            creditsUsed: raw.credits_used || 1
        };

    } catch (error) {
        console.error('[APISH ERROR]', error.response?.data || error.message);

        return {
            success: false,
            error: error.response?.data?.error ||
                error.message ||
                'API request failed.'
        };
    }
});


 // ==========================================
 // IRCTC.DEV - SEAT AVAILABILITY + FARE
 // Existing IPC channel preserved for compatibility
 // ==========================================

ipcMain.handle('irctcdev-availability', async (event, data) => {
    try {
        const {
            trainNumber,
            fromStation,
            toStation,
            journeyDate,
            travelClass,
            quota
        } = data || {};

        const savedKeys = apiKeyStore.getApiKeys();
        const apiKey = savedKeys.irctcDev;

        if (!apiKey) {
            return {
                success: false,
                error: 'IRCTC.dev API key nahi mili. Tokens tab mein key save karein.'
            };
        }

        if (
            !trainNumber ||
            !fromStation ||
            !toStation ||
            !journeyDate ||
            !travelClass ||
            !quota
        ) {
            return {
                success: false,
                error: 'Train, From, To, Date, Class aur Quota zaroori hain.'
            };
        }

        const dateText = String(journeyDate).replace(/-/g, '');

        if (!/^\d{8}$/.test(dateText)) {
            return {
                success: false,
                error: 'Journey date format galat hai.'
            };
        }

        // IRCTC.dev availability requires DD-MM-YYYY.
        const apiDate =
            dateText.substring(6, 8) + '-' +
            dateText.substring(4, 6) + '-' +
            dateText.substring(0, 4);

        const train = String(trainNumber).trim();
        const from = String(fromStation).trim().toUpperCase();
        const to = String(toStation).trim().toUpperCase();
        const cls = String(travelClass).trim().toUpperCase();
        const selectedQuota = String(quota).trim().toUpperCase();

        const headers = {
            'x-api-key': apiKey,
            'accept': 'application/json'
        };

        const availabilityResponse = await axios.get(
            `https://api.irctc.dev/api/v1/trains/${encodeURIComponent(train)}/availability`,
            {
                params: {
                    from,
                    to,
                    date: apiDate,
                    class: cls,
                    quota: selectedQuota
                },
                headers,
                timeout: 30000
            }
        );

        const raw = availabilityResponse.data || {};

        if (raw.success === false) {
            throw new Error(raw.error || 'IRCTC.dev availability request failed.');
        }

        const availabilityList = Array.isArray(raw.availability)
            ? raw.availability
            : [];

        const requestedDate =
            `${dateText.substring(0, 4)}-${dateText.substring(4, 6)}-${dateText.substring(6, 8)}`;

        const selectedDay = availabilityList.find(item => {
            const itemDate = String(item.date || '');
            return itemDate === requestedDate ||
                itemDate === apiDate;
        }) || availabilityList[0];

        if (!selectedDay) {
            throw new Error('IRCTC.dev se availability data nahi mila.');
        }

        let totalFare = null;
        let fareResponseData = null;

        // Fare API documentation lists GN and TQ quotas.
        // PT availability is still checked independently.
        if (selectedQuota === 'GN' || selectedQuota === 'TQ') {
            try {
                const fareResponse = await axios.get(
                    `https://api.irctc.dev/api/v1/trains/${encodeURIComponent(train)}/fare`,
                    {
                        params: {
                            from,
                            to,
                            class: cls,
                            quota: selectedQuota
                        },
                        headers,
                        timeout: 30000
                    }
                );

                fareResponseData = fareResponse.data || {};

                const fares = Array.isArray(fareResponseData.fares)
                    ? fareResponseData.fares
                    : [];

                const selectedFare = fares.find(item =>
                    String(item.class || '').toUpperCase() === cls
                );

                totalFare = selectedFare?.totalFare ?? null;

            } catch (fareError) {
                console.warn(
                    '[IRCTC.DEV FARE] Fare lookup unavailable:',
                    fareError.response?.data || fareError.message
                );
            }
        }

        const statusText = String(
            selectedDay.status || selectedDay.type || '--'
        );

        const availableMatch =
            statusText.match(/AVAILABLE[- ]?(\d+)/i);

        const waitlistMatch =
            statusText.match(/WL(\d+)/i);

        const racMatch =
            statusText.match(/RAC[- /]?(\d+)/i);

        const resultClass = {
            class_code: cls,
            availability_text: statusText,
            available_count: availableMatch
                ? Number(availableMatch[1])
                : null,
            rac_count: racMatch
                ? Number(racMatch[1])
                : null,
            waitlist_count: waitlistMatch
                ? Number(waitlistMatch[1])
                : null,
            total_fare: totalFare,
            last_updated_at: raw._time
                ? `${raw._time}s API response`
                : (raw._cached ? 'Cached response' : '--')
        };

        return {
            success: true,
            data: {
                classes: [resultClass],
                availability: availabilityList
            },
            meta: {
                source: raw.source || 'irctc.dev',
                cached: Boolean(raw._cached),
                responseTime: raw._time ?? null,
                fareAvailable: totalFare !== null
            }
        };

    } catch (error) {
        console.error(
            '[IRCTC.DEV AVAILABILITY ERROR]',
            error.response?.data || error.message
        );

        return {
            success: false,
            error:
                error.response?.data?.error ||
                error.response?.data?.message ||
                error.message ||
                'IRCTC.dev API request failed.'
        };
    }
});


ipcMain.handle(
    'open-mini-automation-window',
    async (event, ticketData, ticketIndex) => {

        try {

            const windowId =
                'mini-' +
                Date.now() +
                '-' +
                Math.random()
                    .toString(36)
                    .substring(2, 7);

            /*
             * Browser identity ticket ke saath preserve karo.
             * WEB / WEB2 / WEB3 hi use honge.
             */
            const browserType =
                String(
                    ticketData?.browserType ||
                    ticketData?.browserChoice ||
                    'WEB'
                )
                .trim()
                .toUpperCase();

            const miniWin =
    new BrowserWindow({

        width: 340,
        height: 220,

        parent: null,
        modal: false,

        frame: false,
        movable: true,

        resizable: false,
        maximizable: false,
        fullscreenable: false,

        alwaysOnTop: true,
        show: true,

                    webPreferences: {
                        preload: path.join(
                            __dirname,
                            'preload.js'
                        ),
                        nodeIntegration: false,
                        contextIsolation: true,
                        backgroundThrottling: false
                    }

                });
                

            miniAutomationWindows.set(
                windowId,
                miniWin
            );

            miniAutomationWindowsByBrowser.set(
    String(browserType || 'WEB')
        .trim()
        .toUpperCase(),
    miniWin
);

            await miniWin.loadFile(
                path.join(
                    __dirname,
                    'mini-window.html'
                )
            );

            /*
             * Browser type ko mini window ke andar
             * explicitly bhejo.
             */
            miniWin.webContents.send(
                'mini-window-data',
                {
                    windowId,
                    ticketData: {
                        ...ticketData,
                        browserType
                    },
                    ticketIndex,
                    browserType
                }
            );

            miniWin.on(
                'closed',
                () => {

                    miniAutomationWindows.delete(
                        windowId
                    );

                }
            );

            console.log(
                `[MINI ${browserType}] Window created: ${windowId}`
            );

            return {
                success: true,
                windowId,
                browserType
            };

        } catch (error) {

            console.error(
                '[MINI WINDOW] Error:',
                error
            );

            return {
                success: false,
                error:
                    error?.message ||
                    'Mini window failed.'
            };
        }
    }
);


ipcMain.on(
    'close-mini-automation-window',
    (event, windowId) => {

        const miniWin =
            miniAutomationWindows.get(
                windowId
            );

        if (
            miniWin &&
            !miniWin.isDestroyed()
        ) {

            miniWin.close();

        }

        miniAutomationWindows.delete(
            windowId
        );
    }
);

ipcMain.on(
    'update-mini-automation-data',
    (event, data) => {

        const windowId =
            data?.windowId;

        const miniWin =
            miniAutomationWindows.get(
                windowId
            );

        if (
            !miniWin ||
            miniWin.isDestroyed()
        ) {
            console.log(
                '[MINI WINDOW] Update skipped. Window not found:',
                windowId
            );
            return;
        }

        miniWin.webContents.send(
            'mini-window-data-update',
            {
                windowId,
                availability:
                    data?.availability || '--',
                fare:
                    data?.fare || '--'
            }
        );

        console.log(
            '[MINI WINDOW] Availability/Fare updated:',
            data?.availability,
            data?.fare
        );
    }
);

// ==========================================
// MULTI-BROWSER CONFIG
// ==========================================

const BOSS_BROWSER_ROOT = path.join(
    process.env.LOCALAPPDATA || os.homedir(),
    'Boss',
    'BrowserProfiles'
);

const BROWSER_CONFIG = {

    WEB: {
        type: 'WEB',
        name: 'Chrome',
        port: 9222,
        userDataDir: path.join(
            BOSS_BROWSER_ROOT,
            'Chrome'
        )
    },

    WEB2: {
        type: 'WEB2',
        name: 'Edge',
        port: 9223,
        userDataDir: path.join(
            BOSS_BROWSER_ROOT,
            'Edge'
        )
    },

    WEB3: {
        type: 'WEB3',
        name: 'Brave',
        port: 9224,
        userDataDir: path.join(
            BOSS_BROWSER_ROOT,
            'Brave'
        )
    },

   WEB4: {
    type: 'WEB4',
    name: 'Firefox',
    port: null,
    userDataDir: path.join(
        BOSS_BROWSER_ROOT,
        'Firefox'
    )
}

};


// ==========================================
// BROWSER SETUP STATE
// ==========================================

const BROWSER_SETUP_VERSION = 1;

const BROWSER_SETUP_FILE = path.join(
    process.env.LOCALAPPDATA || os.homedir(),
    'Boss',
    'browser-setup.json'
);


// ==========================================
// CHECK BROWSER SETUP COMPLETE
// ==========================================

function isBrowserSetupComplete() {

    try {

        if (!fs.existsSync(BROWSER_SETUP_FILE)) {
            return false;
        }

        const data =
            JSON.parse(
                fs.readFileSync(
                    BROWSER_SETUP_FILE,
                    'utf8'
                )
            );

        return (
            data &&
            data.version === BROWSER_SETUP_VERSION &&
            data.completed === true
        );

    } catch (error) {

        console.error(
            '[BROWSER SETUP] Failed to read setup state:',
            error
        );

        return false;
    }
}


// ==========================================
// SAVE BROWSER SETUP COMPLETE
// ==========================================

function saveBrowserSetupComplete() {

    try {

        const dir =
            path.dirname(
                BROWSER_SETUP_FILE
            );

        if (!fs.existsSync(dir)) {

            fs.mkdirSync(
                dir,
                {
                    recursive: true
                }
            );
        }


        fs.writeFileSync(

            BROWSER_SETUP_FILE,

            JSON.stringify(
                {
                    version:
                        BROWSER_SETUP_VERSION,

                    completed:
                        true,

                    completedAt:
                        new Date().toISOString()
                },
                null,
                2
            ),

            'utf8'
        );


        console.log(
            '[BROWSER SETUP] Setup state saved.'
        );

    } catch (error) {

        console.error(
            '[BROWSER SETUP] Failed to save setup state:',
            error
        );
    }
}

// ==========================================
// FIND INSTALLED BROWSER
// ==========================================

function findExistingBrowserPath(paths) {

    for (const browserPath of paths) {

        if (
            browserPath &&
            fs.existsSync(browserPath)
        ) {
            return browserPath;
        }

    }

    return null;
}


function getInstalledBrowserPath(type) {

    const programFiles =
        process.env.ProgramFiles ||
        'C:\\Program Files';

    const programFilesX86 =
        process.env['ProgramFiles(x86)'] ||
        'C:\\Program Files (x86)';

    const localAppData =
        process.env.LOCALAPPDATA ||
        path.join(
            os.homedir(),
            'AppData',
            'Local'
        );


    if (type === 'WEB') {

        return findExistingBrowserPath([

            path.join(
                programFiles,
                'Google',
                'Chrome',
                'Application',
                'chrome.exe'
            ),

            path.join(
                programFilesX86,
                'Google',
                'Chrome',
                'Application',
                'chrome.exe'
            ),

            path.join(
                localAppData,
                'Google',
                'Chrome',
                'Application',
                'chrome.exe'
            )

        ]);

    }


    if (type === 'WEB2') {

        return findExistingBrowserPath([

            path.join(
                programFiles,
                'Microsoft',
                'Edge',
                'Application',
                'msedge.exe'
            ),

            path.join(
                programFilesX86,
                'Microsoft',
                'Edge',
                'Application',
                'msedge.exe'
            ),

            path.join(
                localAppData,
                'Microsoft',
                'Edge',
                'Application',
                'msedge.exe'
            )

        ]);

    }


    if (type === 'WEB3') {

        return findExistingBrowserPath([

            path.join(
                programFiles,
                'BraveSoftware',
                'Brave-Browser',
                'Application',
                'brave.exe'
            ),

            path.join(
                programFilesX86,
                'BraveSoftware',
                'Brave-Browser',
                'Application',
                'brave.exe'
            ),

            path.join(
                localAppData,
                'BraveSoftware',
                'Brave-Browser',
                'Application',
                'brave.exe'
            )

        ]);

    }

     if (type === 'WEB4') {

    return findExistingBrowserPath([

        path.join(
            programFiles,
            'Mozilla Firefox',
            'firefox.exe'
        ),

        path.join(
            programFilesX86,
            'Mozilla Firefox',
            'firefox.exe'
        ),

        path.join(
            localAppData,
            'Mozilla Firefox',
            'firefox.exe'
        )

    ]);

}

    return null;
}


// ==========================================
// GET BROWSER CONFIG
// ==========================================


function getBrowserConfig(browser) {

    const value =
        String(browser || 'WEB')
            .trim()
            .toUpperCase();

    let type = 'WEB';

    if (
        value === 'WEB2' ||
        value === 'WEB 2' ||
        value === 'EDGE'
    ) {

        type = 'WEB2';

    } else if (
        value === 'WEB3' ||
        value === 'WEB 3' ||
        value === 'BRAVE'
    ) {

        type = 'WEB3';

    } else if (
        value === 'WEB4' ||
        value === 'WEB 4' ||
        value === 'FIREFOX'
    ) {

        type = 'WEB4';

    }

    const baseConfig =
        BROWSER_CONFIG[type];

    const exePath =
        getInstalledBrowserPath(type);

    return {
        ...baseConfig,
        exePath,
        installed: Boolean(exePath)
    };

}


// ==========================================
// CHECK REMOTE DEBUGGING STATUS
// ==========================================

async function isBrowserDebugReady(config) {

    if (!config || !config.installed) {
        return false;
    }

    if (config.type === 'WEB4') {
    const firefox = managedBrowserInstances.get('WEB4');
    return Boolean(firefox && firefox.connected);
}

    try {

        const browser =
    await puppeteer.connect({
        browserURL:
            `http://127.0.0.1:${config.port}`,
        defaultViewport: null,
        protocolTimeout: 30 * 60 * 1000
    });

        await browser.disconnect();

        return true;

    } catch (error) {

        return false;

    }
}


// ==========================================
// WAIT FOR REMOTE DEBUGGING
// ==========================================

async function waitForBrowserDebug(
    config,
    timeoutMs = 15000,
    intervalMs = 250
) {

    const startedAt =
        Date.now();

    while (
        Date.now() - startedAt <
        timeoutMs
    ) {

        if (
            await isBrowserDebugReady(config)
        ) {
            return true;
        }

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    intervalMs
                )
        );

    }

    return false;
}


// ==========================================
// LAUNCH BROWSER + WAIT FOR DEBUG PORT
// ==========================================

async function launchBrowser(
    config,
    targetUrl = 'https://www.irctc.co.in'
) {

    if (!config || !config.installed) {

        return {
            success: false,
            status: 'NOT_INSTALLED',
            error:
                `${config?.name || 'Browser'} installed nahi hai.`
        };

    }


    if (
        await isBrowserDebugReady(config)
    ) {

        return {
            success: true,
            status: 'READY',
            alreadyRunning: true,
            browserType: config.type
        };

    }


    try {

        fs.mkdirSync(
            config.userDataDir,
            {
                recursive: true
            }
        );


        console.log(
            `[LAUNCH ${config.type}] Starting ${config.name}...`
        );

        console.log(
            `[LAUNCH ${config.type}] EXE: ${config.exePath}`
        );

        console.log(
            `[LAUNCH ${config.type}] PORT: ${config.port}`
        );

        console.log(
            `[LAUNCH ${config.type}] PROFILE: ${config.userDataDir}`
        );

        // ==========================================
// WEB4 - FIREFOX LAUNCH USING PUPPETEER
// ==========================================

if (config.type === 'WEB4') {

    let firefoxBrowser = null;

    try {

        console.log('[WEB4] Starting Firefox with Puppeteer...');

        const { screen } = require('electron');
const workArea = screen.getPrimaryDisplay().workArea;

const firefoxWidth = 440;
const firefoxHeight = 600;
const firefoxX = Math.max(0, workArea.width - firefoxWidth - 10);
const firefoxY = Math.min(160, Math.max(0, workArea.height - firefoxHeight));

// Firefox ko pehle se right-side position dena
const fs = require('fs');

const xulStorePath = require('path').join(
    config.userDataDir,
    'xulstore.json'
);

let xulStore = {};

try {
    if (fs.existsSync(xulStorePath)) {
        xulStore = JSON.parse(
            fs.readFileSync(xulStorePath, 'utf8')
        );
    }
} catch (e) {
    console.log('[WEB4] Creating fresh window settings');
}

const firefoxWindowSettings = {
    screenX: String(firefoxX),
    screenY: String(firefoxY),
    width: String(firefoxWidth),
    height: String(firefoxHeight),
    sizemode: 'normal'
};

if (!xulStore['chrome://browser/content/browser.xhtml']) {
    xulStore['chrome://browser/content/browser.xhtml'] = {};
}

xulStore['chrome://browser/content/browser.xhtml']['main-window'] =
    firefoxWindowSettings;

fs.writeFileSync(
    xulStorePath,
    JSON.stringify(xulStore, null, 2),
    'utf8'
);

const firefoxArgs = [
    `--width=${firefoxWidth}`,
    `--height=${firefoxHeight}`,
    `--new-window`
];

firefoxBrowser = await puppeteer.launch({

    browser: 'firefox',

    executablePath: config.exePath,

    headless: false,

    userDataDir: config.userDataDir,

    defaultViewport: null,

    protocolTimeout: 30 * 60 * 1000,

    args: firefoxArgs

});

        // Firefox instance ko memory mein save karo
        managedBrowserInstances.set('WEB4', firefoxBrowser);

// WEB4 Firefox manually close hone par profile reset
const firefoxProcess = firefoxBrowser.process?.();

if (firefoxProcess) {

    firefoxProcess.once('close', () => {

        if (
            managedBrowserInstances.get('WEB4') === firefoxBrowser
        ) {
            managedBrowserInstances.delete('WEB4');
        }

        void cleanupBossProfileAfterClose(config);

    });

}

        // Existing tab use karo; nahi ho to naya tab kholo
        const pages = await firefoxBrowser.pages();

        const page = pages.length
            ? pages[0]
            : await firefoxBrowser.newPage();

        if (targetUrl !== 'about:home') {
    await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 120000
    });
} else {
    console.log('[WEB4] Firefox default home page navigation skipped.');
}

const zoomLevel = 0.80; // 80% zoom
        await page.evaluate((z) => {
            document.documentElement.style.zoom = String(z);
        }, zoomLevel).catch(() => {});

        console.log('[WEB4] Firefox launched successfully.');

        return {
            success: true,
            status: 'READY',
            alreadyRunning: false,
            browserType: 'WEB4'
        };

    } catch (firefoxError) {

        if (firefoxBrowser) {
            try {
                await firefoxBrowser.close();
            } catch (_) {}
        }

        managedBrowserInstances.delete('WEB4');

        throw firefoxError;

    }

}

        const { screen } = require('electron');

const workArea = screen.getPrimaryDisplay().workAreaSize;

const browserWidth = 500;
const browserHeight = 660;

// 75% scale factor ke saath actual screen height ka hisaab (~0.80x)
const effectiveHeight = Math.round(browserHeight * 0.80);
const yOffset = 60; // Aur neeche karne ke liye is number ko badhayein (jaise 80 ya 100)
const y = Math.max(0, workArea.height - effectiveHeight + yOffset);

const x =
    config.port === 9222 ? 0 :
    config.port === 9223 ? 455 :
    config.port === 9224 ? 910 : 0;

const appUrl =
    targetUrl && targetUrl !== 'about:home'
        ? targetUrl
        : 'https://www.irctc.co.in/nget/train-search';

const child = spawn(
    config.exePath,
    [
        `--remote-debugging-port=${config.port}`,
        `--user-data-dir=${config.userDataDir}`,
        `--app=${appUrl}`,
        `--window-size=${browserWidth},${browserHeight}`,
        `--window-position=${x},${y}`,
        '--force-device-scale-factor=0.80',
        '--high-dpi-support=1',
        '--no-default-browser-check',
        '--disable-sync',
        '--no-first-run',
        '--disable-default-apps'
    ],
    {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
    }
);

// Boss-launched browser ka exact process track karo.
managedBrowserProcesses.set(config.type, child);

// Browser process completely close hone ke baad Boss profile reset
child.once('close', async () => {

    console.log(
        `[PROFILE RESET ${config.type}] Browser process closed.`
    );

    if (managedBrowserProcesses.get(config.type) === child) {
        managedBrowserProcesses.delete(config.type);
    }

    try {

        // Browser ka debugging port completely band hone ka wait
        const deadline = Date.now() + 20000;
        let browserClosed = false;

        while (Date.now() < deadline) {

            const stillRunning = await isBrowserDebugReady(config);

            if (!stillRunning) {
                browserClosed = true;
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 300));
        }

        if (!browserClosed) {
            console.warn(
                `[PROFILE RESET ${config.type}] Browser still running. Profile NOT deleted.`
            );
            return;
        }

        // Booking chal rahi ho to profile delete mat karo
        if (activeBookingBrowsers.has(config.type)) {
            console.warn(
                `[PROFILE RESET ${config.type}] Booking active. Profile NOT deleted.`
            );
            return;
        }

        // Sirf Boss ka dedicated browser profile delete hoga
        await fs.promises.rm(
            config.userDataDir,
            {
                recursive: true,
                force: true,
                maxRetries: 10,
                retryDelay: 1000
            }
        );

        console.log(
            `[PROFILE RESET ${config.type}] Boss browser profile deleted successfully.`
        );

    } catch (error) {

        console.error(
            `[PROFILE RESET ${config.type}] Profile reset failed:`,
            error.message
        );

    }

});

child.unref();

        const ready =
            await waitForBrowserDebug(
                config,
                15000,
                250
            );


        if (!ready) {

            return {
                success: false,
                status: 'ERROR',
                error:
                    `${config.name} start hua, lekin remote debugging port ${config.port} ready nahi hua.`
            };

        }


        console.log(
            `[LAUNCH ${config.type}] Remote debugging READY.`
        );


        return {
            success: true,
            status: 'READY',
            alreadyRunning: false,
            browserType: config.type
        };


    } catch (error) {

        console.error(
            `[LAUNCH ${config.type}] Failed:`,
            error.message
        );


        return {
            success: false,
            status: 'ERROR',
            error:
                error?.message ||
                `${config.name} launch failed.`
        };

    }

}

// ==========================================
// GET ALL BROWSER STATUSES
// ==========================================

ipcMain.handle(
    'get-browser-statuses',
    async () => {

        const browserTypes = [
            'WEB',
            'WEB2',
            'WEB3',
            'WEB4'
        ];

        const results =
            await Promise.all(
                browserTypes.map(
                    async (type) => {

                        const config =
                            getBrowserConfig(type);

                        const connected =
                            config.installed &&
                            await isBrowserDebugReady(
                                config
                            );

                        return {

                            type:
                                config.type,

                            name:
                                config.name,

                            port:
                                config.port,

                            installed:
                                config.installed,

                            connected:
                                connected,

                            status:
                                !config.installed
                                    ? 'NOT_INSTALLED'
                                    : connected
                                        ? 'READY'
                                        : 'STOPPED',

                            error:
                                null

                        };

                    }
                )
            );


        return {
            success: true,
            statuses: results
        };

    }
);


// ==========================================
// PREPARE ALL INSTALLED BROWSERS
// ==========================================

ipcMain.handle(
    'prepare-browsers',
    async () => {

        const browserTypes = [
            'WEB',
            'WEB2',
            'WEB3'
        ];


        // ==========================================
        // SETUP ALREADY COMPLETED
        // ==========================================

        if (isBrowserSetupComplete()) {

            console.log(
                '[BROWSER SETUP] Setup already completed.'
            );

            console.log(
                '[BROWSER SETUP] Skipping automatic browser launch.'
            );


            const statuses =
                browserTypes.map(
                    (type) => {

                        const config =
                            getBrowserConfig(type);


                        return {

                            type:
                                config.type,

                            name:
                                config.name,

                            port:
                                config.port,

                            installed:
                                config.installed,

                            /*
                             * Browser ko yahan launch/check nahi karna.
                             * READY ka matlab:
                             * browser installed hai aur user
                             * icon par click karke connect kar sakta hai.
                             */
                            connected:
                                false,

                            status:
                                config.installed
                                    ? 'READY'
                                    : 'NOT_INSTALLED',

                            setupComplete:
                                true,

                            error:
                                null
                        };

                    }
                );


            return {

                success:
                    true,

                setupComplete:
                    true,

                setupSkipped:
                    true,

                statuses:
                    statuses
            };
        }


        // ==========================================
        // FIRST-TIME SETUP
        // ==========================================

        console.log(
            '[BROWSER SETUP] First-time setup started.'
        );


        const results =
            await Promise.all(
                browserTypes.map(
                    async (type) => {

                        const config =
                            getBrowserConfig(type);


                        console.log(
                            `[BROWSER STATUS] ${config.name}: ` +
                            `${config.installed ? 'Installed' : 'Not Installed'}`
                        );


                        // ------------------------------------------
                        // NOT INSTALLED
                        // ------------------------------------------

                        if (!config.installed) {

                            return {

                                type:
                                    config.type,

                                name:
                                    config.name,

                                port:
                                    config.port,

                                installed:
                                    false,

                                connected:
                                    false,

                                status:
                                    'NOT_INSTALLED',

                                error:
                                    `${config.name} installed nahi hai.`

                            };
                        }


                        // ------------------------------------------
                        // FIRST SETUP -> LAUNCH
                        // ------------------------------------------

                        const result =
                            await launchBrowser(
                                config
                            );


                        return {

                            type:
                                config.type,

                            name:
                                config.name,

                            port:
                                config.port,

                            installed:
                                true,

                            connected:
                                Boolean(
                                    result.success
                                ),

                            status:
                                result.status,

                            error:
                                result.error ||
                                null

                        };

                    }
                )
            );


        // ==========================================
        // SAVE SETUP ONLY WHEN ALL INSTALLED
        // BROWSERS ARE READY
        // ==========================================

        const installedResults =
            results.filter(
                browser =>
                    browser.installed
            );


        const setupSuccessful =
            installedResults.length > 0 &&
            installedResults.every(
                browser =>
                    browser.status === 'READY'
            );


        if (setupSuccessful) {

            saveBrowserSetupComplete();

            console.log(
                '[BROWSER SETUP] First-time setup completed.'
            );

        } else {

            console.log(
                '[BROWSER SETUP] Setup not marked complete.'
            );

        }


        return {

            success:
                true,

            setupComplete:
                setupSuccessful,

            setupSkipped:
                false,

            statuses:
                results
        };

    }
);

ipcMain.handle(
    'open-selected-browser',
    async (event, browserName) => {

        try {

            const config =
                getBrowserConfig(browserName);

            const targetUrl = browserName === 'WEB4'
    ? 'https://www.irctc.co.in/eticket/train-search'
    : 'about:home';

            console.log(
                `[LAUNCH ${config.type}] ` +
                `${config.name} ` +
                `Port=${config.port} ` +
                `Profile=${config.userDataDir}`
            );


            const result =
                await launchBrowser(
                    config,
                    targetUrl
                );


            if (!result.success) {

                return {
                    success: false,
                    browserType: config.type,
                    status: result.status,
                    error: result.error
                };

            }


            return {
                success: true,
                browserType: config.type,
                status: result.status,
                alreadyRunning:
                    Boolean(result.alreadyRunning)
            };


        } catch (error) {

            console.error(
                '[LAUNCH] Browser launch failed:',
                error.message
            );


            return {
                success: false,
                error:
                    error?.message ||
                    'Browser launch failed.'
            };

        }

    }
);

const activeBookingBrowsers = new Set();


/* ==========================================
   CLEAR SELECTED BROWSER PROFILE DATA
========================================== */

ipcMain.handle(
    'clear-browser-data',
    async (event, browserName) => {

        const allowedTypes = {
            WEB: 'WEB',
            CHROME: 'WEB',
            WEB2: 'WEB2',
            EDGE: 'WEB2',
            WEB3: 'WEB3',
            BRAVE: 'WEB3',
            WEB4: 'WEB4',
            FIREFOX: 'WEB4'
        };

        const type = allowedTypes[
            String(browserName || '').trim().toUpperCase()
        ];

        if (!type) {
            return {
                success: false,
                error: 'Invalid browser selected.'
            };
        }

        
const config = getBrowserConfig(type);

// ==========================================
// CHECK BROWSER INSTALLATION BEFORE CLEARING
// ==========================================

if (
    !config ||
    !config.installed ||
    !config.exePath ||
    !fs.existsSync(config.exePath)
) {
    console.warn(
        `[CLEAR DATA ${type}] Browser is not installed.`
    );

    return {
        success: false,
        browserType: type,
        browserName: config?.name || type,
        error:
            `${config?.name || type} PC mein installed nahi hai. Data clear nahi kiya gaya.`
    };
}

if (activeBookingBrowsers.has(type)) {

            return {
                success: false,
                error: `${config.name} mein booking chal rahi hai.`
            };
        }

        try {

            console.log(
                `[CLEAR DATA ${type}] Starting profile reset:`,
                config.userDataDir
            );

            // ==========================================
            // STEP 1: CLOSE SELECTED BROWSER
            // ==========================================

            if (type === 'WEB4') {

                // Firefox Puppeteer-managed session
                const firefoxBrowser =
                    managedBrowserInstances.get('WEB4');

                if (firefoxBrowser?.connected) {
    await firefoxBrowser.close();
}

managedBrowserInstances.delete('WEB4');

                console.log(
                    '[CLEAR DATA WEB4] Firefox closed.'
                );

                // Firefox close hone ka wait
                const deadline = Date.now() + 15000;

                while (Date.now() < deadline) {

                    const currentFirefox =
                        managedBrowserInstances.get('WEB4');

                    if (!currentFirefox ||
                        !currentFirefox.connected) {
                        break;
                    }

                    await new Promise(resolve =>
                        setTimeout(resolve, 300)
                    );
                }

            } else {

                // Chrome / Edge / Brave
                const running =
                    await isBrowserDebugReady(config);

                if (running) {

                    const browser =
                        await puppeteer.connect({
                            browserURL:
                                `http://127.0.0.1:${config.port}`,
                            defaultViewport: null,
                            protocolTimeout: 30 * 60 * 1000
                        });

                    await browser.close();

                    console.log(
                        `[CLEAR DATA ${type}] Browser close requested.`
                    );

                    // Browser completely close hone ka wait
                    const deadline = Date.now() + 15000;

                    let closed = false;

                    while (Date.now() < deadline) {

                        if (!(await isBrowserDebugReady(config))) {
                            closed = true;
                            break;
                        }

                        await new Promise(resolve =>
                            setTimeout(resolve, 300)
                        );
                    }

                    if (!closed) {
                        throw new Error(
                            `${config.name} properly close nahi hua. Profile data delete nahi kiya gaya.`
                        );
                    }
                }

                managedBrowserProcesses.delete(type);
            }

            // ==========================================
            // STEP 2: DELETE ONLY BOSS PROFILE
            // ==========================================

            await fs.promises.rm(
                config.userDataDir,
                {
                    recursive: true,
                    force: true,
                    maxRetries: 10,
                    retryDelay: 1000
                }
            );

            // ==========================================
            // STEP 3: VERIFY OLD PROFILE REMOVED
            // ==========================================

            if (fs.existsSync(config.userDataDir)) {
                throw new Error(
                    'Old profile folder delete nahi hua.'
                );
            }

            // ==========================================
            // STEP 4: CREATE FRESH PROFILE
            // ==========================================

            await fs.promises.mkdir(
                config.userDataDir,
                {
                    recursive: true
                }
            );

            const stat = await fs.promises.stat(
                config.userDataDir
            );

            if (!stat.isDirectory()) {
                throw new Error(
                    'Fresh profile folder create nahi hua.'
                );
            }

            console.log(
                `[CLEAR DATA ${type}] Profile reset VERIFIED.`
            );

            return {
                success: true,
                browserType: type,
                browserName: config.name,
                message:
                    `${config.name} ka BOSS browser profile data clear ho gaya.`
            };

        } catch (error) {

            console.error(
                `[CLEAR DATA ${type}] RESET FAILED:`,
                error
            );

            return {
                success: false,
                error:
                    error?.message ||
                    'Browser profile reset nahi ho saka.'
            };
        }
    }
);

// ==========================================
// WL PROCEED / CANCEL RESPONSE
// ==========================================
ipcMain.handle(
    'wl-decision-response',
    async (event, payload = {}) => {

        const windowId = String(payload.windowId || '');
        const decision = String(payload.decision || '').toLowerCase();

        const pending = pendingWLDecisions.get(windowId);

        if (!pending) {
            return {
                success: false,
                error: 'WL decision request nahi mila.'
            };
        }

        if (decision !== 'proceed' && decision !== 'cancel') {
            return {
                success: false,
                error: 'Invalid WL decision.'
            };
        }

        pendingWLDecisions.delete(windowId);
        pending(decision);

        return { success: true };
    }
);

// ==========================================
// START BOOKING HANDLER
// ==========================================

ipcMain.handle(
    'start-booking',
    async (
    event,
    bookingData,
    targetBrowser,
    windowId
) => {

        const bookingBrowser =
            String(
                targetBrowser || 'WEB'
            )
            .trim()
            .toUpperCase();


        // ==========================================
        // DUPLICATE BOOKING PROTECTION
        // ==========================================

        if (
            activeBookingBrowsers.has(
                bookingBrowser
            )
        ) {

            console.warn(
                `[MAIN] Booking already running for ${bookingBrowser}. Duplicate request blocked.`
            );

            return {
                success: false,
                error:
                    `Booking already running for ${bookingBrowser}.`
            };
        }


        // Lock BEFORE starting browser/API work
        activeBookingBrowsers.add(
            bookingBrowser
        );

        console.log(
            `[MAIN] Booking lock acquired: ${bookingBrowser}`
        );


let miniWin = null;
let browser = null;
let browserTypeForCleanup = null;

try {

    console.log(
        `[MAIN] Starting booking for browser: ${targetBrowser}`
    );

            const config =
                getBrowserConfig(targetBrowser);

            browserTypeForCleanup = config.type;

            const port =
                config.port;

            const exePath =
                config.exePath;

            const userDataDir =
                config.userDataDir;

            const targetUrl =
    config.type === 'WEB4'
        ? 'https://www.irctc.co.in/eticket/train-search'
        : 'https://www.irctc.co.in/nget/train-search';

            console.log(
                `[${config.type}] Port=${port} Profile=${userDataDir}`
            );

const launchResult =
    await launchBrowser(
        config,
        targetUrl
    );

if (!launchResult.success) {

    throw new Error(
        launchResult.error ||
        `${config.name} launch nahi ho saka.`
    );
}

console.log(
    `[${config.type}] Browser READY. ` +
    `Already running: ${Boolean(launchResult.alreadyRunning)}`
);


if (config.type === 'WEB4') {

    // WEB4 - Firefox ka managed Puppeteer session
    browser = managedBrowserInstances.get('WEB4');

    if (!browser || !browser.connected) {
        throw new Error(
            'Firefox Puppeteer session available nahi hai. Firefox ko Open Browser button se start karein.'
        );
    }

    console.log('[WEB4] Firefox Puppeteer session connected.');

} else {

    // WEB / WEB2 / WEB3 - Firefox connection
    let retries = 6;

    while (retries > 0) {

        try {

            browser = await puppeteer.connect({
                browserURL: `http://127.0.0.1:${port}`,
                defaultViewport: null,
                protocolTimeout: 30 * 60 * 1000
            });

            break;

        } catch (err) {

            retries--;

            if (retries === 5) {

                console.log(
                    `[${config.type}] Browser connection failed. Waiting for existing browser...`
                );

                const ready = await waitForBrowserDebug(
                    config,
                    10000,
                    500
                );

                if (!ready) {
                    throw new Error(
                        `${config.name} remote debugging port ${port} available nahi hai. ` +
                        `Please ${config.name} ko Open Browser button se start karein.`
                    );
                }
            }

            if (retries === 0) {
                throw new Error(
                    `Failed to connect to ${config.type} on port ${port}.`
                );
            }

            await new Promise(resolve =>
                setTimeout(resolve, 1500)
            );
        }
    }
}

let page = null;

try {

    console.log(
        `[${config.type}] Using existing browser page...`
    );

    const pages = await browser.pages();

    page =
        pages.find(p =>
            (p.url() || '').includes('irctc.co.in')
        ) ||
        pages[0] ||
        await browser.newPage();

    if (!page) {
        throw new Error(
            `${config.name} mein browser page available nahi hai.`
        );
    }

    if (!page.url() || page.url() === 'about:blank') {
        await page.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 120000
        });
    }

    console.log(
        `[${config.type}] Existing browser page selected: ${await page.url()}`
    );

    const zoomLevel = 0.80; // 80% zoom
    await page.evaluate((z) => {
        document.documentElement.style.zoom = String(z);
    }, zoomLevel).catch(() => {});

} catch (pageError) {

    console.error(
        `[${config.type}] Existing browser page failed:`,
        pageError.message
    );

    throw new Error(
        `${config.name} browser page use nahi ho saka: ` +
        pageError.message
    );
}


            console.log(
                `[${config.type}] Connected to page: ${await page.url()}`
            );

            miniWin =
    windowId
        ? miniAutomationWindows.get(windowId)
        : null;

if (
    miniWin &&
    !miniWin.isDestroyed()
) {
    miniAutomationWindowsByBrowser.set(
        config.type,
        miniWin
    );

     console.log(
        `[MINI MAP] ${config.type} mapped to window: ${windowId}`
    );
}

       const apiEngine = new APIEngine(
    page,
    miniWin,
    null,
    config.type,
    {
        showQR: (data) => {

    const qrWindow =
    createQRPaymentWindow(config.type, miniWin)

    if (
        !qrWindow ||
        qrWindow.isDestroyed()
    ) {
        return;
    }

    const sendQR = () => {
        if (
    qrWindow &&
    !qrWindow.isDestroyed()
) {
    qrWindow.webContents.send(
        'payment-qr-show',
        data
    );

    console.log(
        `[MAIN] ${config.type} QR data sent after QR window loaded.`
    );
}
    };

    if (qrWindow.webContents.isLoading()) {

        qrWindow.webContents.once(
            'did-finish-load',
            sendQR
        );

    } else {

        sendQR();
    }
},

        hideQR: () => {

    const qrWindow =
        qrPaymentWindows.get(
            config.type
        );

    if (
        qrWindow &&
        !qrWindow.isDestroyed()
    ) {
        qrWindow.close();
    }

    qrPaymentWindows.delete(
        config.type
    );
},

        updateQRTimer: (data) => {

    const qrWindow =
        qrPaymentWindows.get(
            config.type
        );

    if (
        !qrWindow ||
        qrWindow.isDestroyed()
    ) {
        return;
    }

    if (
        qrWindow.webContents.isLoading()
    ) {
        return;
    }

    qrWindow.webContents.send(
        'payment-qr-timer',
        data
    );
},

        // ==========================================
// WL CONFIRMATION REQUEST
// ==========================================
requestWLDecision: (wlNumber) => {

    return new Promise((resolve) => {

        const id = String(windowId || '');

        const wlMiniWin = id
            ? miniAutomationWindows.get(id)
            : null;

        if (
            !id ||
            !wlMiniWin ||
            wlMiniWin.isDestroyed()
        ) {
            console.error('[WL] Mini window unavailable.');
            resolve('cancel');
            return;
        }

        const oldRequest =
            pendingWLDecisions.get(id);

        if (oldRequest) {
            oldRequest('cancel');
            pendingWLDecisions.delete(id);
        }

        pendingWLDecisions.set(id, resolve);

        const sendWLRequest = () => {

            if (
                wlMiniWin.isDestroyed() ||
                !pendingWLDecisions.has(id)
            ) {
                pendingWLDecisions.delete(id);
                resolve('cancel');
                return;
            }

            wlMiniWin.webContents.send(
                'wl-decision-request',
                {
                    windowId: id,
                    wlNumber: wlNumber
                }
            );

            console.log(
                '[WL] Confirmation popup sent:',
                wlNumber
            );
        };

        if (wlMiniWin.webContents.isLoading()) {

            wlMiniWin.webContents.once(
                'did-finish-load',
                sendWLRequest
            );

        } else {

            sendWLRequest();
        }
    });
}
    }
);

// ==========================================
// NORMALIZE IRCTC CREDENTIALS
// ==========================================

if (
    !bookingData.credentials ||
    typeof bookingData.credentials !== 'object'
) {
    bookingData.credentials = {};
}

bookingData.credentials.username =
    String(
        bookingData.credentials.username || ''
    ).trim();

bookingData.credentials.password =
    String(
        bookingData.credentials.password || ''
    );

// ==========================================
// START API ENGINE BOOKING
// ==========================================

const result =
    await apiEngine.bookTicket(
        bookingData
    );


            return result;

                } catch (error) {

            console.error(
                '[MAIN] Error during booking flow:',
                error.message
            );

            return {
                success: false,
                error:
                    error.message
            };

       } finally {

        // ==========================================
// CLEANUP PUPPETEER CONNECTION
// Keep all browser windows OPEN.
// Never disconnect managed Firefox session.
// ==========================================

if (
    browser &&
    browserTypeForCleanup !== 'WEB4'
) {
    try {

        browser.disconnect();

        console.log(
            `[MAIN] ${browserTypeForCleanup} Puppeteer disconnected. Browser remains open.`
        );

    } catch (disconnectError) {

        console.warn(
            '[MAIN] Browser disconnect warning:',
            disconnectError.message
        );
    }
}

    // ==========================================
    // RELEASE BOOKING LOCK
    // Runs on success, error, or exception
    // ==========================================

    activeBookingBrowsers.delete(
        bookingBrowser
    );

    console.log(
        `[MAIN] Booking lock released: ${bookingBrowser}`
    );

    // ==========================================
    // MINI WINDOW BOOKING BUTTON UNLOCK
    // ==========================================

    if (
    miniWin &&
    !miniWin.isDestroyed()
) {

    console.log(
        `[MAIN] Sending booking unlock to mini window: ${bookingBrowser}`
    );

    miniWin.webContents.send(
        'booking-lock-update',
        {
            browserType: bookingBrowser,
            locked: false
        }
    );

} else {

    console.warn(
        `[MAIN] Mini window unavailable for unlock: ${bookingBrowser}`
    );
}

}
}
);


// ==========================================
// CREATE INDEPENDENT LICENSE WINDOW
// ==========================================

function createLicenseWindow() {

    if (
        licenseWindow &&
        !licenseWindow.isDestroyed()
    ) {
        licenseWindow.focus();
        return;
    }

    licenseWindow = new BrowserWindow({

        width: 350,
        height: 290,

        minWidth: 350,
        minHeight: 290,

        maxWidth: 350,
        maxHeight: 290,

        frame: false,
        transparent: true,

        resizable: false,
        movable: true,

        minimizable: false,
        maximizable: false,
        fullscreenable: false,

        alwaysOnTop: true,

        show: false,

        webPreferences: {

            preload: path.join(
                __dirname,
                'preload.js'
            ),

            nodeIntegration: false,
            contextIsolation: true
        }
    });

    licenseWindow.loadFile(
        path.join(
            __dirname,
            'license.html'
        )
    );

    licenseWindow.once(
        'ready-to-show',
        () => {

            if (
                licenseWindow &&
                !licenseWindow.isDestroyed()
            ) {

                licenseWindow.show();
                licenseWindow.focus();
            }
        }
    );

    licenseWindow.on(
        'closed',
        () => {

            licenseWindow = null;

            /*
             * Agar user ne valid license enter kiye
             * bina window close kar di, application
             * close kar do.
             */

            if (!licenseVerified) {

                if (!app.isQuitting) {
                    app.quit();
                }
            }
        }
    );
}


ipcMain.on('close-license-window', () => {

    console.log('[LICENSE] Close button clicked');

    if (
        licenseWindow &&
        !licenseWindow.isDestroyed()
    ) {
        licenseWindow.close();
    }
});


ipcMain.handle('verify-license-key', async (event, licenseKey) => {
    console.log('[LICENSE] Verification request received:', licenseKey);

    try {
        const key = String(licenseKey || '').trim();

        if (!key) {
            console.log('[LICENSE] Empty key');

            return {
                success: false,
                message: 'License key enter karein.'
            };
        }

        console.log('[LICENSE] Calling verifyLicense()...');

        const result = await verifyLicense(key);

        console.log('[LICENSE] Firebase result:', result);

        if (!result || !result.success) {
            return {
                success: false,
                message: result?.message || 'Invalid license key.'
            };
        }
activeLicenseScope = createLicenseScope(key);
        apiKeyStore.setLicenseScope(activeLicenseScope);
        applyLicenseBrowserRoot(activeLicenseScope);

        licenseVerified = true;

console.log('[LICENSE] Verification SUCCESS');

// License window abhi close nahi hogi.
// Pehle license.html expiry date save karega.

return {
    success: true,
    message: result.message,
    expiryDate: result.expiryDate
};


    } catch (error) {

        console.error(
            '[LICENSE] Verification ERROR:',
            error
        );

        return {
            success: false,
            message:
                error?.message ||
                'License verification failed.'
        };
    }
});

ipcMain.on('complete-license-activation', () => {
    console.log('[LICENSE] Completing activation...');

    if (licenseWindow && !licenseWindow.isDestroyed()) {
        licenseWindow.close();
    }

    if (!win || win.isDestroyed()) {
        console.log('[LICENSE] Creating dashboard...');
        createWindow();
    } else {
        console.log('[LICENSE] Showing existing dashboard...');
        win.show();
        win.focus();
    }
});

// ==========================================
// CREATE WINDOW
// ==========================================
function createWindow() {

    if (!licenseVerified) {
        return;
    }

    if (
        win &&
        !win.isDestroyed()
    ) {
        win.show();
        win.focus();
        return;
    }

    win = new BrowserWindow({
    width: 900,
    height: 800,

    frame: false,
    transparent: true,

    show: false,

    alwaysOnTop: false,
    hasShadow: false,

    backgroundColor: '#00000000',

    resizable: false,
    movable: false,
    maximizable: false,
    fullscreenable: false,

    webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        nodeIntegration: false,
        contextIsolation: true
    }
});


    // 1. New window/popup ya document khulne se rokne ke liye
win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.includes('bobrupay.pdf') || url.includes('credit-card') || url.includes('co-brand') || url.includes('compare') || url.includes('ipay') || url.includes('drfat')) {
        console.log('[SECURITY] Blocked promotional document/popup:', url);
        return { action: 'deny' };
    }
    return { action: 'allow' };
});

// 2. Agar current window par hi yeh document load ho jaye toh wapas pichle page par jaane ke liye
win.webContents.on('did-navigate', async (event, url) => {
    if (url.includes('bobrupay.pdf') || url.includes('credit-card') || url.includes('co-brand') || url.includes('compare') || url.includes('ipay') || url.includes('drfat')) {
        console.log('[SECURITY] Blocked navigation to promotional doc. Going back...', url);
        if (win.webContents.canGoBack()) {
            win.webContents.goBack();
        }
    }
});


// ==========================================
    // FORCE CLOSE ALL WINDOWS & PROCESSES ON DASHBOARD CLOSE
    // ==========================================
    win.on('closed', () => {
        win = null;
        // Electron process level exit to immediately close mini-windows and child processes
        app.exit(0); 
    });


    // Load your app URL or file here (e.g., win.loadURL(...))


    // Real Chrome User-Agent set kar rahe hain
    const realUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    win.webContents.setUserAgent(realUserAgent);

    if (!activeLicenseScope) {
        throw new Error('License data scope missing; dashboard load blocked.');
    }

    win.loadFile(
        path.join(__dirname, 'index.html'),
        { query: { licenseScope: activeLicenseScope } }
    );

    win.once(
    'ready-to-show',
    () => {

        if (
            licenseVerified &&
            win &&
            !win.isDestroyed()
        ) {

            win.show();
            win.focus();
        }
    }
);
   
    win.on('closed', () => {
        win = null;
    });
}

// ==========================================
// SESSION EXTRACTION HELPER
// ==========================================

async function saveUserSession(
    targetWindow,
    browserType = 'WEB'
) {
    try {

        const type =
            String(browserType || 'WEB')
                .trim()
                .toUpperCase();

        const safeType =
            type === 'WEB2'
                ? 'web2'
                : type === 'WEB3'
                    ? 'web3'
                    : 'web';

        console.log(
            `[SESSION ${type}] Extracting session...`
        );

        const cookies =
            await targetWindow
                .webContents
                .session
                .cookies
                .get({
                    url:
                        'https://www.irctc.co.in'
                });

        const cookieString =
            cookies && cookies.length
                ? cookies
                    .map(
                        c =>
                            `${c.name}=${c.value}`
                    )
                    .join('; ')
                : '';

        const storageData =
            await targetWindow
                .webContents
                .executeJavaScript(`
                    (() => {

                        const localStorageData = {};
                        const sessionStorageData = {};

                        try {

                            for (
                                let i = 0;
                                i < localStorage.length;
                                i++
                            ) {
                                const key =
                                    localStorage.key(i);

                                localStorageData[key] =
                                    localStorage.getItem(key);
                            }

                            for (
                                let i = 0;
                                i < sessionStorage.length;
                                i++
                            ) {
                                const key =
                                    sessionStorage.key(i);

                                sessionStorageData[key] =
                                    sessionStorage.getItem(key);
                            }

                        } catch (e) {}

                        return {
                            localStorage:
                                localStorageData,

                            sessionStorage:
                                sessionStorageData
                        };

                    })();
                `)
                .catch(() => ({
                    localStorage: {},
                    sessionStorage: {}
                }));

        if (!activeLicenseScope) {
            throw new Error('License scope unavailable; refusing to save shared session data.');
        }

        const sessionDir = path.join(
            app.getPath('userData'),
            'LicenseData',
            activeLicenseScope,
            'Sessions'
        );

        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(
                sessionDir,
                {
                    recursive: true
                }
            );
        }

        const sessionFilePath =
            path.join(
                sessionDir,
                `session_${safeType}.json`
            );

        const fullSessionPayload = {
            browserType: type,
            cookies: cookieString,
            localStorage:
                storageData.localStorage || {},
            sessionStorage:
                storageData.sessionStorage || {}
        };

        fs.writeFileSync(
            sessionFilePath,
            JSON.stringify(
                fullSessionPayload,
                null,
                2
            ),
            'utf8'
        );

        console.log(
            `[SESSION ${type}] Saved: ${sessionFilePath}`
        );

        return sessionFilePath;

    } catch (sessionErr) {

        console.error(
            `[SESSION ${browserType}] Save failed:`,
            sessionErr.message
        );

        return null;
    }
}

// ==========================================
// APP READY
// ==========================================

app.whenReady().then(() => {

    /*
     * IMPORTANT:
     * App start par dashboard nahi,
     * sirf independent license window open hogi.
     */
    createLicenseWindow();

    app.on('activate', () => {

        /*
         * License verify nahi hua hai to
         * dashboard create/open nahi karna.
         */
        if (!licenseVerified) {

            if (
                !licenseWindow ||
                licenseWindow.isDestroyed()
            ) {
                createLicenseWindow();
            }

            return;
        }

        if (
            BrowserWindow.getAllWindows().length === 0
        ) {
            createWindow();
        }

    });
});

// ==========================================
// CLOSE ALL WINDOWS
// ==========================================

app.on('window-all-closed', () => {

    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// ==========================================
// RESIZE WINDOW
// ==========================================


ipcMain.on('resize-window', (event, size = {}) => {
    if (!win || win.isDestroyed()) return;

    const width = Number(size.width);
    const height = Number(size.height);

    if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
    ) {
        return;
    }

    const oldBounds = win.getBounds();

    win.setBounds({
        x: oldBounds.x,
        y: oldBounds.y,
        width: Math.round(width),
        height: Math.round(height)
    });
});

// ==========================================
// CAPTCHA STATE - PER BROWSER
// ==========================================

const captchaStates = {
    WEB: {
        active: false,
        resolve: null,
        reject: null,
        timeout: null
    },
    WEB2: {
        active: false,
        resolve: null,
        reject: null,
        timeout: null
    },
    WEB3: {
        active: false,
        resolve: null,
        reject: null,
        timeout: null
    }
};

function getCaptchaState(browserType) {
    const type = String(browserType || 'WEB')
        .trim()
        .toUpperCase();

    return captchaStates[type] || captchaStates.WEB;
}

// ==========================================
// CAPTCHA REQUEST
// ==========================================

function requestCaptchaFromUser(
    captchaImageSrc,
    browserType = 'WEB'
) {
    const state = getCaptchaState(browserType);

    return new Promise((resolve, reject) => {

        if (!win || win.isDestroyed()) {
            reject(
                new Error(
                    'Electron window available nahi hai.'
                )
            );
            return;
        }

        if (state.active) {
            reject(
                new Error(
                    `[${browserType}] Another CAPTCHA request is already active.`
                )
            );
            return;
        }

        state.active = true;
        state.resolve = resolve;
        state.reject = reject;

        state.timeout = setTimeout(() => {

            finishCaptchaRequest(
                new Error('CAPTCHA input timeout.'),
                null,
                browserType
            );

        }, 5 * 60 * 1000);

        win.webContents.send(
            'show-captcha-modal',
            {
                browserType: String(browserType || 'WEB').toUpperCase(),
                image: captchaImageSrc || null
            }
        );
    });
}

// ==========================================
// FINISH CAPTCHA REQUEST
// ==========================================

function finishCaptchaRequest(
    error = null,
    value = null,
    browserType = 'WEB'
) {
    const state = getCaptchaState(browserType);

    if (!state.active) {
        return;
    }

    if (state.timeout) {
        clearTimeout(state.timeout);
        state.timeout = null;
    }

    const resolve = state.resolve;
    const reject = state.reject;

    state.active = false;
    state.resolve = null;
    state.reject = null;

    if (error) {
        if (reject) {
            reject(error);
        }
        return;
    }

    if (resolve) {
        resolve(value);
    }
}

// ==========================================
// CAPTCHA SUBMIT
// ==========================================

ipcMain.on(
    'submit-captcha-response',
    (event, data) => {

        let browserType = 'WEB';
        let captchaText = '';

        if (
            data &&
            typeof data === 'object'
        ) {
            browserType =
                data.browserType || 'WEB';

            captchaText =
                data.captcha ||
                data.text ||
                '';
        } else {
            captchaText = data || '';
        }

        const state =
            getCaptchaState(browserType);

        if (!state.active) {

            console.warn(
                `[CAPTCHA ${browserType}] No active CAPTCHA request.`
            );

            return;
        }

        const value =
            String(captchaText || '').trim();

        if (!value) {

            console.warn(
                `[CAPTCHA ${browserType}] Empty CAPTCHA received.`
            );

            return;
        }

        console.log(
            `[CAPTCHA ${browserType}] User CAPTCHA received.`
        );

        finishCaptchaRequest(
            null,
            value,
            browserType
        );
    }
);

// ==========================================
// CAPTCHA CANCEL
// ==========================================

ipcMain.on(
    'cancel-captcha-response',
    (event, data) => {

        const browserType =
            data &&
            typeof data === 'object'
                ? data.browserType || 'WEB'
                : 'WEB';

        const state =
            getCaptchaState(browserType);

        if (!state.active) {
            return;
        }

        console.log(
            `[CAPTCHA ${browserType}] User cancelled CAPTCHA.`
        );

        finishCaptchaRequest(
            new Error(
                'CAPTCHA cancelled by user.'
            ),
            null,
            browserType
        );
    }
);

// ==========================================
// CAPTCHA IPC HANDLER
// ==========================================

ipcMain.handle(
    'solve-captcha-interactively',
    async (
        event,
        captchaImageSrc,
        browserType = 'WEB'
    ) => {

        try {

            const captcha =
                await requestCaptchaFromUser(
                    captchaImageSrc,
                    browserType
                );

            return {
                success: true,
                captcha
            };

        } catch (error) {

            return {
                success: false,
                error:
                    error?.message ||
                    'CAPTCHA failed.'
            };
        }
    }
);

// ==========================================
// START LOGIN
// ==========================================

ipcMain.handle(
    'start-login',
    async (
        event,
        payload = {}
    ) => {

        const browserChoice =
            String(
                payload.browserChoice || 'web'
            ).toLowerCase();

        const credentials =
            payload.credentials || null;

        console.log(
            '[LOGIN] Browser:',
            browserChoice
        );

        try {

            const result =
                await startManualLogin(
                    browserChoice,
                    credentials,
                    {
                        timeout:
                            30 * 60 * 1000
                    }
                );

            if (!result?.success) {

                return {
                    success: false,

                    error:
                        result?.error ||
                        'Login failed.'
                };
            }

            console.log(
                '[LOGIN] Login successful.'
            );

            return {
                success: true,

                message:
                    'IRCTC login successful.',

                session:
                    result.session || null
            };

        } catch (error) {

            console.error(
                '[LOGIN] Error:',
                error
            );

            return {
                success: false,

                error:
                    error?.message ||
                    'Login failed.'
            };
        }
    }
);

// ==========================================
// START TATKAL BOOKING
// ==========================================

ipcMain.handle(
    'start-tatkal-booking',
    async (
        event,
        payload = {}
    ) => {

        let browser = null;
let browserTypeForCleanup = null;
let bookingBrowser = null;
let bookingLockAcquired = false;

try {

            console.log(
                '[BOOKING] start-tatkal-booking received.'
            );

            console.log(
    '[DEBUG] Tatkal booking payload received.'
);

            const targetBrowser =
                payload.browserType ||
                payload.browserChoice ||
                payload.ticketData?.browserChoice ||
                'WEB';

            const config =
                getBrowserConfig(targetBrowser);

                browserTypeForCleanup = config.type;

            bookingBrowser = config.type;

// ==========================================
// DUPLICATE TATKAL BOOKING PROTECTION
// ==========================================

if (activeBookingBrowsers.has(bookingBrowser)) {

    console.warn(
        `[TATKAL] Booking already running for ${bookingBrowser}. Duplicate request blocked.`
    );

    return {
        success: false,
        error: `Booking already running for ${bookingBrowser}.`
    };
}

activeBookingBrowsers.add(bookingBrowser);
bookingLockAcquired = true;

console.log(
    `[TATKAL] Booking lock acquired: ${bookingBrowser}`
);

            const port =
                config.port;

            const exePath =
                config.exePath;

            const userDataDir =
                config.userDataDir;

            
const targetUrl =
    config.type === 'WEB4'
        ? 'https://www.irctc.co.in/eticket/train-search'
        : 'https://www.irctc.co.in/nget/train-search';


            console.log(
                `[${config.type}] Port=${port} Profile=${userDataDir}`
            );


// ==========================================
// WEB4 - FIREFOX SESSION
// ==========================================

if (config.type === 'WEB4') {

    browser = managedBrowserInstances.get('WEB4');

    // Firefox session nahi mila to launch karo
    if (!browser || !browser.connected) {

        const launchResult = await launchBrowser(
            config,
            targetUrl
        );

        if (!launchResult.success) {
            throw new Error(
                launchResult.error || 'Firefox launch nahi ho saka.'
            );
        }

        browser = managedBrowserInstances.get('WEB4');
    }

    if (!browser || !browser.connected) {
        throw new Error(
            'Firefox Puppeteer session available nahi hai.'
        );
    }

    console.log('[WEB4] Firefox session connected for Tatkal.');

}

// ==========================================
// WEB / WEB2 / WEB3 - FIREFOX CONNECTION
// ==========================================

else {

    let retries = 6;

    while (retries > 0) {

        try {

            browser = await puppeteer.connect({
                browserURL: `http://127.0.0.1:${port}`,
                defaultViewport: null,
                protocolTimeout: 30 * 60 * 1000
            });

            break;

        } catch (err) {

            retries--;

            if (retries === 5) {

                console.log(
                    `[${config.type}] Browser connection failed. Waiting for existing browser...`
                );

                const ready = await waitForBrowserDebug(
                    config,
                    10000,
                    500
                );

                if (!ready) {
                    throw new Error(
                        `${config.name} remote debugging port ${port} available nahi hai.`
                    );
                }
            }

            if (retries === 0) {
                throw new Error(
                    `Failed to connect to ${config.type} on port ${port}.`
                );
            }

            await new Promise(resolve => setTimeout(resolve, 1500));
        }
    }

}

let page = null;

try {

    console.log(
        `[${config.type}] Using existing browser page for Tatkal...`
    );

    const pages = await browser.pages();

page =
    pages.find(p => (p.url() || '').includes('irctc.co.in')) ||
    pages[0] ||
    await browser.newPage();

if (!page) {
    throw new Error(
        `${config.name} mein naya browser page nahi ban saka.`
    );
}

    console.log(
        `[${config.type}] Existing page selected: ${await page.url()}`
    );

    if (
        !page.url() ||
        page.url() === 'about:blank'
    ) {
        await page.goto(
            targetUrl,
            {
                waitUntil: 'domcontentloaded',
                timeout: 120000
            }
        );
    }

    const zoomLevel = 0.80; // 80% zoom
    await page.evaluate((z) => {
        document.documentElement.style.zoom = String(z);
    }, zoomLevel).catch(() => {});

} catch (pageError) {

    console.error(
        `[${config.type}] Tatkal page selection failed:`,
        pageError.message
    );

    throw new Error(
        `${config.name} existing page use nahi ho saka: ` +
        pageError.message
    );
}


            console.log(
                `[${config.type}] Connected to page: ${await page.url()}`
            );


            // ==========================================
            // TATKAL MINI WINDOW MAPPING
            // ==========================================

            const windowId =
                payload.windowId ||
                payload.ticketData?.windowId ||
                null;

            let miniWin =
                windowId
                    ? miniAutomationWindows.get(windowId)
                    : null;

            // Fallback: use the mini window already mapped
            // to this browser type when windowId is missing.
            if (
                !miniWin ||
                miniWin.isDestroyed()
            ) {
                miniWin =
                    miniAutomationWindowsByBrowser.get(
                        config.type
                    ) || null;
            }

            if (
                miniWin &&
                !miniWin.isDestroyed()
            ) {
                miniAutomationWindowsByBrowser.set(
                    config.type,
                    miniWin
                );

                console.log(
                    `[MINI MAP] Tatkal ${config.type} mapped successfully`,
                    windowId ? `windowId=${windowId}` : '(browser fallback)'
                );
            } else {
                console.warn(
                    `[MINI MAP] No mini window found for ${config.type}`
                );
            }


            const ticketData =
                payload.ticketData ||
                payload ||
                {};

            const apiEngine =
    new APIEngine(
        page,
        miniWin,
        null,
        config.type,
        {
            showQR: (data) => {

console.log(
    '[QR MAP DEBUG]',
    'browser =',
    config.type,
    'mini mapped =',
    miniAutomationWindowsByBrowser.has(config.type)
);

    const qrWindow =
    createQRPaymentWindow(config.type, miniWin)

                if (
                    !qrWindow ||
                    qrWindow.isDestroyed()
                ) {
                    return;
                }

                const sendQR = () => {

                   if (
    qrWindow &&
    !qrWindow.isDestroyed()
) {
    qrWindow.webContents.send(
        'payment-qr-show',
        data
    );

                        console.log(
                            '[MAIN] QR data sent after QR window loaded.'
                        );
                    }
                };

                if (
                    qrWindow.webContents.isLoading()
                ) {

                    qrWindow.webContents.once(
                        'did-finish-load',
                        sendQR
                    );

                } else {

                    sendQR();
                }
            },

            hideQR: () => {

    const qrWindow =
        qrPaymentWindows.get(
            config.type
        );

    if (
        qrWindow &&
        !qrWindow.isDestroyed()
    ) {
        qrWindow.close();
    }

    qrPaymentWindows.delete(
        config.type
    );
},

            updateQRTimer: (data) => {

    const qrWindow =
        qrPaymentWindows.get(
            config.type
        );

    if (
        !qrWindow ||
        qrWindow.isDestroyed()
    ) {
        return;
    }

    if (
        qrWindow.webContents.isLoading()
    ) {
        return;
    }

    qrWindow.webContents.send(
        'payment-qr-timer',
        data
    );
}
        }
    );

            console.log(
                `[${config.type}] Tatkal booking starting for Train:`,
                ticketData.train ||
                ticketData.trainNo ||
                'N/A'
            );

console.log(
    `[${config.type}] Tatkal credentials received:`,
    ticketData?.credentials?.username ? 'YES' : 'NO'
);

console.log(
    `[${config.type}] Tatkal password received:`,
    ticketData?.credentials?.password ? 'YES' : 'NO'
);

            const response =
                await apiEngine.bookTicket(
                    ticketData,
                    payload.webOption || null
                );

            console.log(
                `[${config.type}] Tatkal booking process completed.`
            );

            return {
                success: true,
                data: response
            };

       
        } catch (error) {

            console.error(
                '[API ENGINE] Tatkal booking failed:',
                error
            );

            return {
                success: false,
                error:
                    error?.message ||
                    'Booking failed.'
            };

        } finally {

            // Firefox managed session ko disconnect nahi karna.

            if (
                browser &&
                browserTypeForCleanup &&
                browserTypeForCleanup !== 'WEB4'
            ) {
                try {

                    browser.disconnect();

                    console.log(
                        `[TATKAL] ${browserTypeForCleanup} Puppeteer disconnected. Browser remains open.`
                    );

                } catch (disconnectError) {

                    console.warn(
                        '[TATKAL] Browser disconnect warning:',
                        disconnectError.message
                    );
                }
            }

            // ==========================================
// RELEASE TATKAL BOOKING LOCK
// ==========================================

if (bookingLockAcquired && bookingBrowser) {

    activeBookingBrowsers.delete(bookingBrowser);

    console.log(
        `[TATKAL] Booking lock released: ${bookingBrowser}`
    );
}
        }
    }
);


// ==========================================
// OPEN SPECIFIC BROWSER IPC HANDLER (UPDATED WITH DEBUG PORTS)
// ==========================================

ipcMain.handle(
    'open-browser-ticket',
    async (event, { browserType, ticketData }) => {

        try {

            const config =
                getBrowserConfig(browserType);

            
const targetUrl =
    config.type === 'WEB4'
        ? 'https://www.irctc.co.in/eticket/train-search'
        : 'https://www.irctc.co.in/nget/train-search';


            console.log(
                `[OPEN ${config.type}] ` +
                `${config.name} | ` +
                `Port=${config.port} | ` +
                `Profile=${config.userDataDir}`
            );

            const result =
                await launchBrowser(
                    config,
                    targetUrl
                );

            if (!result.success) {

                return {
                    success: false,
                    browserType: config.type,
                    status: result.status,
                    error: result.error
                };
            }

            return {
                success: true,
                browserType: config.type,
                status: result.status,
                alreadyRunning:
                    Boolean(result.alreadyRunning)
            };

        } catch (error) {

            console.error(
                '[OPEN BROWSER TICKET] Error:',
                error
            );

            return {
                success: false,
                error:
                    error?.message ||
                    'Browser open failed.'
            };
        }
    }
);

// ==========================================
// CLEANUP BEFORE APP QUIT
// ==========================================

app.on('before-quit', () => {

    for (
        const browserType of
        ['WEB', 'WEB2', 'WEB3']
    ) {

        const state =
            getCaptchaState(browserType);

        if (state.active) {

            finishCaptchaRequest(
                new Error(
                    'Application closed.'
                ),
                null,
                browserType
            );
        }
    }
});